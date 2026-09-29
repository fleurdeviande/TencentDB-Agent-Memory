import "../stdio-guard.js";
import { serve } from "../serve.js";

serve().catch((error) => {
  process.stderr.write(`[pw-memory] mcp server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
