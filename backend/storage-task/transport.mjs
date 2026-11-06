import { fail } from './canonical.mjs';
// Projection only, NOT a route or a stream store. Call read after live auth first.
// No token-delta retry: terminal text appears once in result event, client dedups by id.
export function terminalEvents(response, lastEventId = null) {
  const taskId = response.taskId;
  if (!/^[a-f0-9]{32}$/.test(taskId || '')) fail('invalid_task_id');
  let after = -1;
  if (lastEventId !== null) {
    const parts = String(lastEventId).split(':');
    if (parts.length !== 2 || parts[0] !== taskId || !/^[012]$/.test(parts[1])) fail('invalid_resume', 409);
    after = Number(parts[1]);
  }
  const events = [{ id: taskId + ':0', event: 'ack', data: { taskId } }];
  if (['completed', 'failed', 'stopped'].includes(response.status)) {
    const data = { taskId, parentTaskId: response.parentTaskId ?? null, status: response.status,
      text: response.status === 'completed' ? response.text : null };
    events.push({ id: taskId + ':1', event: 'result', data },
      { id: taskId + ':2', event: 'eos', data: { taskId, status: response.status } });
  } else if (!['pending', 'running'].includes(response.status)) fail('invalid_status');
  return events.filter(event => Number(event.id.split(':')[1]) > after);
}
