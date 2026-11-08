import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { SessionDatabase } from "../server/utils/session-database";
const source = resolve(process.argv[2] || ".data/food");
const target = resolve(process.argv[3] || join(homedir(), "Library/Application Support/com.freefood.desktop"));
const database = await SessionDatabase.open(target);
try {
  database.acquireRuntimeLock();
  const result = await database.importLegacy(source);
  console.log(`已导入 ${result.imported} 份数据，源文件保留。`);
} finally { database.close(); }
