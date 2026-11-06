-- Fixed EVAL script, exactly one hash-tagged scope key. Never interpolate user data
-- into the script or KEYS. No TTL, lease stealing, or automatic provider retry.
-- Scope is authenticated in backend before reaching this service-only interface.
if #KEYS ~= 1 or #ARGV ~= 1 then return cjson.encode({error='transaction_shape', status=400}) end
local c = cjson.decode(ARGV[1])
local function err(reason, status) return cjson.encode({error=reason, status=status or 409}) end
local function valid(n) return type(n)=='number' and n>=0 and n<=9000000000000 and math.floor(n)==n end
local function present(x) return x ~= nil and x ~= cjson.null end
local raw = redis.call('GET', KEYS[1])
local s = raw and cjson.decode(raw) or nil
if c.op == 'provision' then
  if not valid(c.limitUnits) or not valid(c.maxTasks) or c.maxTasks<1 or not valid(c.maxDepth) then return err('invalid_units',400) end
  if not s then
    s={limitUnits=c.limitUnits,reserved=0,spent=0,count=0,tasks={},bindings={},stoppedScopes={},maxTasks=c.maxTasks,maxDepth=c.maxDepth,sessions={}}
    redis.call('SET',KEYS[1],cjson.encode(s))
  end
  return cjson.encode({limitUnits=s.limitUnits,reserved=s.reserved,spent=s.spent,count=s.count})
end
if not s then return err('ledger_unavailable',503) end
local function public(r, replay)
  local response = r.response
  if not present(response) then response={taskId=r.taskId,parentTaskId=r.parentTaskId,status=r.status,text=cjson.null} end
  local code = (r.status=='pending' or r.status=='running') and 202 or 200
  return {ok=true,status=code,replay=replay,response=response}
end
local function save(result) redis.call('SET',KEYS[1],cjson.encode(s)); return cjson.encode(result) end
local function terminal(r) return r.status=='completed' or r.status=='failed' or r.status=='stopped' end
if c.op=='snapshot' then return cjson.encode({limitUnits=s.limitUnits,reserved=s.reserved,spent=s.spent,count=s.count}) end
if c.op=='registerSession' then
  if type(c.authRef)~='string' or not valid(c.expiresAt) then return err('auth',401) end
  local existing=s.sessions[c.authRef]
  if existing then return cjson.encode({registered=not existing.revoked}) end
  s.sessions[c.authRef]={expiresAt=c.expiresAt,revoked=false,authVersion=c.authVersion,sessionRole=c.sessionRole}
  return save({registered=true})
end
if c.op=='revokeSession' then
  s.sessions[c.authRef]={expiresAt=0,revoked=true}
  return save({revoked=true})
end
local function authorized()
  local a=s.sessions[c.authRef]
  local t=redis.call('TIME')
  local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
  return a and not a.revoked and a.expiresAt>now and a.authVersion==c.authVersion and a.sessionRole==c.sessionRole
end
-- start handles pending cancellation atomically below; finish is a fenced worker
-- reconciliation operation and must remain possible after user revocation.
if (c.op=='admit' or c.op=='read' or c.op=='stop') and not authorized() then return err('auth',401) end
if c.op=='admit' then
  local b=c.bound
  if not valid(c.reserveUnits) then return err('invalid_units',400) end
  if present(b.taskId) then
    local r=s.tasks[b.taskId]
    if not r then return err('missing',404) end
    if r.bodyHash~=b.bodyHash or r.routeScope~=b.routeScope or (present(b.binding) and s.bindings[b.binding]~=r.taskId) then return err('hash_conflict') end
    return cjson.encode(public(r,true))
  end
  local prior=present(b.binding) and s.bindings[b.binding] or nil
  if prior then
    local r=s.tasks[prior]
    if r.bodyHash~=b.bodyHash or r.routeScope~=b.routeScope or r.parentTaskId~=b.parentTaskId then return err('hash_conflict') end
    return cjson.encode(public(r,true))
  end
  local parent=nil
  if present(b.parentTaskId) then
    parent=s.tasks[b.parentTaskId]
    if not parent or parent.routeScope~=b.routeScope or parent.bodyHash~=b.parentHash then return err('parent',403) end
    if parent.status~='stopped' or not present(parent.settlementHash) then return err('parent_unsettled') end
    if present(parent.childTaskId) or parent.depth>=s.maxDepth then return err('lineage_limit') end
  end
  if c.available~=true then return err('unavailable',503) end
  if s.count>=s.maxTasks then return err('task_limit',429) end
  if c.reserveUnits>s.limitUnits-s.spent-s.reserved then return err('budget',429) end
  if s.tasks[c.taskId] then return err('id_collision') end
  local r={taskId=c.taskId,parentTaskId=b.parentTaskId,bodyHash=b.bodyHash,routeScope=b.routeScope,
    depth=parent and parent.depth+1 or 0,childTaskId=cjson.null,tokenHash=c.tokenHash,
    reserveUnits=c.reserveUnits,chargedUnits=cjson.null,settlementHash=cjson.null,finishHash=cjson.null,
    providerState='not_started',status='pending',started=false,response=cjson.null}
  s.tasks[r.taskId]=r; if present(b.binding) then s.bindings[b.binding]=r.taskId end
  s.count=s.count+1; s.reserved=s.reserved+c.reserveUnits
  if parent then parent.childTaskId=r.taskId end
  local out=public(r,false); out.taskId=r.taskId
  return save(out)
end
local r=s.tasks[c.taskId]
if not r then return err('missing',404) end
if c.op=='read' then return cjson.encode(public(r,true)) end
if c.op=='stop' then
  if terminal(r) then return cjson.encode(public(r,true)) end
  if not r.started then
    s.reserved=s.reserved-r.reserveUnits; r.chargedUnits=0
    r.settlementHash=c.notCommittedHash; r.providerState='not_committed'
  end
  r.status='stopped'; s.stoppedScopes[r.routeScope]=true
  r.response={taskId=r.taskId,parentTaskId=r.parentTaskId,status='stopped',text=cjson.null}
  return save(public(r,true))
end
if c.tokenHash~=r.tokenHash then return err('fence') end
if c.op=='start' then
  if not authorized() then
    if r.status=='pending' then
      s.reserved=s.reserved-r.reserveUnits; r.chargedUnits=0
      r.providerState='not_committed'; r.settlementHash=c.notCommittedHash; r.status='stopped'
      r.response={taskId=r.taskId,parentTaskId=r.parentTaskId,status='stopped',text=cjson.null}
      return save({error='auth',status=401})
    end
    return err('auth',401)
  end
  if r.status~='pending' or r.started then local out=public(r,true); out.execute=false; return cjson.encode(out) end
  r.started=true; r.status='running'; r.providerState='unknown'
  return save({execute=true,taskId=r.taskId})
end
if c.op=='finish' then
  local x=c.result
  if x.outcome~='committed' and x.outcome~='not_committed' and x.outcome~='unknown' then return err('invalid_outcome',400) end
  if not valid(x.actualUnits) or x.actualUnits>r.reserveUnits or (x.outcome~='committed' and x.actualUnits~=0) then return err('invalid_charge',400) end
  if x.completed and (not r.started or x.outcome~='committed' or type(x.text)~='string' or not string.find(x.text,'%S')) then return err('invalid_generation',400) end
  if present(r.finishHash) and r.finishHash~=c.responseHash then return err('response_conflict') end
  if present(r.settlementHash) then
    if r.settlementHash~=c.settlementHash then return err('settlement_conflict') end
  elseif x.outcome=='unknown' then
    r.providerState='unknown'; return save(public(r,true))
  else
    if x.outcome=='committed' and not r.started then return err('not_started') end
    s.reserved=s.reserved-r.reserveUnits; s.spent=s.spent+x.actualUnits
    r.chargedUnits=x.actualUnits; r.providerState=x.outcome; r.usage=x.usage
    r.settlementHash=c.settlementHash
  end
  r.finishHash=c.responseHash
  if not terminal(r) then
    r.status=x.completed and 'completed' or 'failed'
    r.response={taskId=r.taskId,parentTaskId=r.parentTaskId,status=r.status,text=x.completed and x.text or cjson.null}
  end
  return save(public(r,true))
end
return err('unknown_operation',400)
