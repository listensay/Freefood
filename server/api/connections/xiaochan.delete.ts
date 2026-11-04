import { disconnectPlatform } from "../../utils/connections";

export default defineEventHandler((event) =>
  disconnectPlatform(event, "xiaochan"),
);
