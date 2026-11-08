import { defineEventHandler, readBody } from "h3";
import { sessionId } from "../../../../utils/session";
import { inputMeituanRemote } from "../../../../utils/meituan";
import { remoteOperation, remoteToken } from "../../../../utils/remote-request";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const token = remoteToken(event);
  const action = await readBody(event);
  await remoteOperation(() => inputMeituanRemote(id, token, action));
  return { ok: true };
});
