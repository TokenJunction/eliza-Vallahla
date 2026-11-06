-- Keep this schema OUT of exposed Data API schemas. Direct server PostgreSQL only.
-- PENDING REVIEW FIXTURE ONLY. Not an assertion about existing Supabase schema.
-- No migration was applied. Service-only RPC, account lock serializes every operation.
BEGIN;
CREATE SCHEMA IF NOT EXISTS valhalla_task_pending;
CREATE TABLE valhalla_task_pending.accounts (
  tenant text NOT NULL, subject text NOT NULL,
  limit_units bigint NOT NULL CHECK (limit_units BETWEEN 0 AND 9000000000000),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  max_tasks integer NOT NULL CHECK (max_tasks > 0), max_depth integer NOT NULL CHECK (max_depth >= 0),
  PRIMARY KEY (tenant,subject), CHECK (reserved + spent <= limit_units)
);
CREATE TABLE valhalla_task_pending.live_sessions (
  tenant text NOT NULL, subject text NOT NULL, auth_ref text NOT NULL,
  expires_at bigint NOT NULL, auth_version integer NOT NULL, session_role text NOT NULL, revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant,subject,auth_ref),
  FOREIGN KEY (tenant,subject) REFERENCES valhalla_task_pending.accounts
);
CREATE TABLE valhalla_task_pending.tasks (
  tenant text NOT NULL, subject text NOT NULL, task_id text NOT NULL,
  idempotency_key uuid, normalized_request_hash text NOT NULL CHECK (normalized_request_hash ~ '^[a-f0-9]{64}$'),
  route_scope text NOT NULL, parent_task_id text, child_task_id text, depth integer NOT NULL,
  token_hash text NOT NULL, reserve_units bigint NOT NULL CHECK (reserve_units >= 0),
  charged_units bigint, settlement_hash text, finish_hash text,
  started boolean NOT NULL DEFAULT false, provider_state text NOT NULL DEFAULT 'not_started'
    CHECK (provider_state IN ('not_started','unknown','committed','not_committed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','stopped')),
  response jsonb, usage jsonb,
  PRIMARY KEY (tenant,subject,task_id), UNIQUE (tenant,subject,idempotency_key),
  UNIQUE (tenant,subject,parent_task_id),
  FOREIGN KEY (tenant,subject) REFERENCES valhalla_task_pending.accounts,
  FOREIGN KEY (tenant,subject,parent_task_id) REFERENCES valhalla_task_pending.tasks(tenant,subject,task_id)
);
ALTER TABLE valhalla_task_pending.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE valhalla_task_pending.live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE valhalla_task_pending.tasks ENABLE ROW LEVEL SECURITY;
-- No browser policies. A caller's role/JWT/body must not pick another tenant.
REVOKE ALL ON SCHEMA valhalla_task_pending FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA valhalla_task_pending FROM PUBLIC;

CREATE FUNCTION valhalla_task_pending.reply(r valhalla_task_pending.tasks, replay boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,valhalla_task_pending AS $$
 SELECT jsonb_build_object('ok',true,'status',CASE WHEN r.status IN ('pending','running') THEN 202 ELSE 200 END,
 'replay',replay,'response',coalesce(r.response,jsonb_build_object('taskId',r.task_id,'parentTaskId',r.parent_task_id,'status',r.status,'text',NULL)))
$$;

CREATE FUNCTION valhalla_task_pending.task_tx(p_tenant text, p_subject text, c jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,valhalla_task_pending AS $$
DECLARE
 a valhalla_task_pending.accounts; r valhalla_task_pending.tasks; p valhalla_task_pending.tasks;
 b jsonb := c->'bound'; x jsonb := c->'result'; op text := c->>'op';
 tid text := c->>'taskId'; v_auth_ref text := c->>'authRef'; live boolean; amount bigint; actual bigint;
 idem uuid; parent_id text; new_response jsonb; n bigint;
BEGIN
 IF p_tenant IS NULL OR p_subject IS NULL OR length(p_tenant) NOT BETWEEN 1 AND 256 OR length(p_subject) NOT BETWEEN 1 AND 256 THEN
   RETURN jsonb_build_object('error','auth','status',401);
 END IF;
 IF op='provision' THEN
   INSERT INTO valhalla_task_pending.accounts(tenant,subject,limit_units,max_tasks,max_depth)
     VALUES(p_tenant,p_subject,(c->>'limitUnits')::bigint,(c->>'maxTasks')::integer,(c->>'maxDepth')::integer)
     ON CONFLICT DO NOTHING; -- replay cannot reset a spent balance
 END IF;
 SELECT * INTO a FROM valhalla_task_pending.accounts WHERE tenant=p_tenant AND subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','ledger_unavailable','status',503); END IF;
 IF op IN ('provision','snapshot') THEN
   SELECT count(*) INTO n FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject;
   RETURN jsonb_build_object('limitUnits',a.limit_units,'reserved',a.reserved,'spent',a.spent,'count',n);
 END IF;
 IF op='registerSession' THEN
   INSERT INTO valhalla_task_pending.live_sessions(tenant,subject,auth_ref,expires_at,auth_version,session_role)
     VALUES(p_tenant,p_subject,v_auth_ref,(c->>'expiresAt')::bigint,(c->>'authVersion')::integer,c->>'sessionRole') ON CONFLICT DO NOTHING;
   SELECT NOT revoked INTO live FROM valhalla_task_pending.live_sessions
     WHERE tenant=p_tenant AND subject=p_subject AND live_sessions.auth_ref=v_auth_ref;
   RETURN jsonb_build_object('registered',live);
 END IF;
 IF op='revokeSession' THEN
   INSERT INTO valhalla_task_pending.live_sessions(tenant,subject,auth_ref,expires_at,auth_version,session_role,revoked)
     VALUES(p_tenant,p_subject,v_auth_ref,0,0,'revoked',true)
     ON CONFLICT (tenant,subject,auth_ref) DO UPDATE SET revoked=true,expires_at=0;
   RETURN jsonb_build_object('revoked',true);
 END IF;
 SELECT coalesce(bool_or(NOT revoked AND auth_version=(c->>'authVersion')::integer AND session_role=c->>'sessionRole' AND expires_at > floor(extract(epoch FROM clock_timestamp())*1000)),false) INTO live
   FROM valhalla_task_pending.live_sessions WHERE tenant=p_tenant AND subject=p_subject AND live_sessions.auth_ref=v_auth_ref;
 IF op IN ('admit','read','stop') AND NOT live THEN RETURN jsonb_build_object('error','auth','status',401); END IF;
 IF op='admit' THEN
   amount := (c->>'reserveUnits')::bigint;
   IF amount<0 OR amount>9000000000000 THEN RETURN jsonb_build_object('error','invalid_units','status',400); END IF;
   IF b->>'taskId' IS NOT NULL THEN
     SELECT * INTO r FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject AND task_id=b->>'taskId';
     IF NOT FOUND THEN RETURN jsonb_build_object('error','missing','status',404); END IF;
     IF r.normalized_request_hash IS DISTINCT FROM b->>'bodyHash' OR r.route_scope IS DISTINCT FROM b->>'routeScope'
       OR (b->>'binding' IS NOT NULL AND r.idempotency_key::text IS DISTINCT FROM b->>'binding') THEN
       RETURN jsonb_build_object('error','hash_conflict','status',409);
     END IF;
     RETURN valhalla_task_pending.reply(r);
   END IF;
   IF b->>'binding' IS NOT NULL THEN
     IF b->>'binding' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
       RETURN jsonb_build_object('error','invalid_idempotency_key','status',400);
     END IF;
     idem := (b->>'binding')::uuid;
     SELECT * INTO r FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject AND idempotency_key=idem;
     IF FOUND THEN
       IF r.normalized_request_hash IS DISTINCT FROM b->>'bodyHash' OR r.route_scope IS DISTINCT FROM b->>'routeScope'
         OR r.parent_task_id IS DISTINCT FROM b->>'parentTaskId' THEN
         RETURN jsonb_build_object('error','hash_conflict','status',409);
       END IF;
       RETURN valhalla_task_pending.reply(r);
     END IF;
   END IF;
   parent_id := b->>'parentTaskId';
   IF parent_id IS NOT NULL THEN
     SELECT * INTO p FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject AND task_id=parent_id;
     IF NOT FOUND OR p.route_scope IS DISTINCT FROM b->>'routeScope' OR p.normalized_request_hash IS DISTINCT FROM b->>'parentHash' THEN
       RETURN jsonb_build_object('error','parent','status',403);
     END IF;
     IF p.status<>'stopped' OR p.settlement_hash IS NULL THEN RETURN jsonb_build_object('error','parent_unsettled','status',409); END IF;
     IF p.child_task_id IS NOT NULL OR p.depth>=a.max_depth THEN RETURN jsonb_build_object('error','lineage_limit','status',409); END IF;
   END IF;
   IF c->>'available' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('error','unavailable','status',503); END IF;
   SELECT count(*) INTO n FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject;
   IF n>=a.max_tasks THEN RETURN jsonb_build_object('error','task_limit','status',429); END IF;
   IF amount>a.limit_units-a.reserved-a.spent THEN RETURN jsonb_build_object('error','budget','status',429); END IF;
   IF tid !~ '^[a-f0-9]{32}$' OR c->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','invalid_identity','status',400); END IF;
   INSERT INTO valhalla_task_pending.tasks(tenant,subject,task_id,idempotency_key,normalized_request_hash,route_scope,
     parent_task_id,depth,token_hash,reserve_units)
     VALUES(p_tenant,p_subject,tid,idem,b->>'bodyHash',b->>'routeScope',parent_id,
       CASE WHEN parent_id IS NULL THEN 0 ELSE p.depth+1 END,c->>'tokenHash',amount) RETURNING * INTO r;
   IF parent_id IS NOT NULL THEN UPDATE valhalla_task_pending.tasks SET child_task_id=tid WHERE tenant=p_tenant AND subject=p_subject AND task_id=parent_id; END IF;
   UPDATE valhalla_task_pending.accounts SET reserved=reserved+amount WHERE tenant=p_tenant AND subject=p_subject;
   RETURN valhalla_task_pending.reply(r,false) || jsonb_build_object('taskId',tid);
 END IF;
 SELECT * INTO r FROM valhalla_task_pending.tasks WHERE tenant=p_tenant AND subject=p_subject AND task_id=tid;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','missing','status',404); END IF;
 IF op='read' THEN RETURN valhalla_task_pending.reply(r); END IF;
 IF op='stop' THEN
   IF r.status IN ('completed','failed','stopped') THEN RETURN valhalla_task_pending.reply(r); END IF;
   IF NOT r.started THEN
     UPDATE valhalla_task_pending.accounts SET reserved=reserved-r.reserve_units WHERE tenant=p_tenant AND subject=p_subject;
     r.provider_state:='not_committed'; r.charged_units:=0; r.settlement_hash:=c->>'notCommittedHash';
   END IF;
   r.status:='stopped'; r.response:=jsonb_build_object('taskId',tid,'parentTaskId',r.parent_task_id,'status','stopped','text',NULL);
 ELSIF op IN ('start','finish') THEN
   IF r.token_hash IS DISTINCT FROM c->>'tokenHash' THEN RETURN jsonb_build_object('error','fence','status',409); END IF;
   IF op='start' THEN
     IF NOT live THEN
       IF r.status='pending' THEN
         UPDATE valhalla_task_pending.accounts SET reserved=reserved-r.reserve_units WHERE tenant=p_tenant AND subject=p_subject;
         UPDATE valhalla_task_pending.tasks SET status='stopped',charged_units=0,provider_state='not_committed',
           settlement_hash=c->>'notCommittedHash',response=jsonb_build_object('taskId',tid,'parentTaskId',r.parent_task_id,'status','stopped','text',NULL)
           WHERE tenant=p_tenant AND subject=p_subject AND task_id=tid;
       END IF;
       RETURN jsonb_build_object('error','auth','status',401);
     END IF;
     IF r.status<>'pending' OR r.started THEN RETURN valhalla_task_pending.reply(r) || jsonb_build_object('execute',false); END IF;
     UPDATE valhalla_task_pending.tasks SET started=true,status='running',provider_state='unknown' WHERE tenant=p_tenant AND subject=p_subject AND task_id=tid;
     RETURN jsonb_build_object('execute',true,'taskId',tid);
   END IF;
   actual:=(x->>'actualUnits')::bigint;
   IF x->>'outcome' NOT IN ('committed','not_committed','unknown') OR x->>'outcome' IS NULL THEN RETURN jsonb_build_object('error','invalid_outcome','status',400); END IF;
   IF actual<0 OR actual>r.reserve_units OR (x->>'outcome'<>'committed' AND actual<>0) THEN RETURN jsonb_build_object('error','invalid_charge','status',400); END IF;
   IF x->>'completed'='true' AND (NOT r.started OR x->>'outcome'<>'committed' OR jsonb_typeof(x->'text') IS DISTINCT FROM 'string' OR length(btrim(x->>'text'))=0) THEN
     RETURN jsonb_build_object('error','invalid_generation','status',400);
   END IF;
   IF r.finish_hash IS NOT NULL AND r.finish_hash IS DISTINCT FROM c->>'responseHash' THEN RETURN jsonb_build_object('error','response_conflict','status',409); END IF;
   IF r.settlement_hash IS NOT NULL THEN
     IF r.settlement_hash IS DISTINCT FROM c->>'settlementHash' THEN RETURN jsonb_build_object('error','settlement_conflict','status',409); END IF;
   ELSIF x->>'outcome'='unknown' THEN
     UPDATE valhalla_task_pending.tasks SET provider_state='unknown' WHERE tenant=p_tenant AND subject=p_subject AND task_id=tid;
     RETURN valhalla_task_pending.reply(r);
   ELSE
     IF x->>'outcome'='committed' AND NOT r.started THEN RETURN jsonb_build_object('error','not_started','status',409); END IF;
     UPDATE valhalla_task_pending.accounts SET reserved=reserved-r.reserve_units,spent=spent+actual WHERE tenant=p_tenant AND subject=p_subject;
     r.provider_state:=x->>'outcome'; r.charged_units:=actual; r.usage:=x->'usage'; r.settlement_hash:=c->>'settlementHash';
   END IF;
   r.finish_hash:=c->>'responseHash';
   IF r.status NOT IN ('completed','failed','stopped') THEN
     r.status:=CASE WHEN x->>'completed'='true' THEN 'completed' ELSE 'failed' END;
     r.response:=jsonb_build_object('taskId',tid,'parentTaskId',r.parent_task_id,'status',r.status,'text',CASE WHEN r.status='completed' THEN x->>'text' ELSE NULL END);
   END IF;
 ELSE RETURN jsonb_build_object('error','unknown_operation','status',400);
 END IF;
 UPDATE valhalla_task_pending.tasks SET status=r.status,response=r.response,provider_state=r.provider_state,
   charged_units=r.charged_units,settlement_hash=r.settlement_hash,finish_hash=r.finish_hash,usage=r.usage
   WHERE tenant=p_tenant AND subject=p_subject AND task_id=tid RETURNING * INTO r;
 RETURN valhalla_task_pending.reply(r);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA valhalla_task_pending FROM PUBLIC;
-- Supabase roles may not exist in an offline SQL harness; do not invent them.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
   REVOKE ALL ON SCHEMA valhalla_task_pending FROM anon;
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA valhalla_task_pending FROM anon;
   REVOKE ALL ON ALL TABLES IN SCHEMA valhalla_task_pending FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
   REVOKE ALL ON SCHEMA valhalla_task_pending FROM authenticated;
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA valhalla_task_pending FROM authenticated;
   REVOKE ALL ON ALL TABLES IN SCHEMA valhalla_task_pending FROM authenticated;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   GRANT USAGE ON SCHEMA valhalla_task_pending TO service_role;
   GRANT EXECUTE ON FUNCTION valhalla_task_pending.task_tx(text,text,jsonb) TO service_role;
 END IF;
END $$;
COMMIT;
