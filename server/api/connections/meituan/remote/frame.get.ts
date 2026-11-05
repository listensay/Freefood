import { sessionId } from "../../../../utils/session";
import {
  captureMeituanFrame,
  meituanLoginIssue,
} from "../../../../utils/meituan";
import { remoteOperation, remoteToken } from "../../../../utils/remote-request";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const token = remoteToken(event);
  const image = await remoteOperation(() => captureMeituanFrame(id, token));
  const issue = meituanLoginIssue(id, token);
  if (issue) setHeader(event, "X-Food-Login-Issue", issue);
  setHeader(event, "Content-Type", "image/jpeg");
  setHeader(event, "X-Content-Type-Options", "nosniff");
  return image;
});
