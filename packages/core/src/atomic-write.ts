import { writeFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

/**
 * Write data to a file atomically using write-to-temp-then-rename.
 * Ensures the file is never left in a partially-written state.
 */
export function atomicWriteSync(targetPath: string, data: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(tmpPath, data, "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Atomically write a JSON-serializable value to a file.
 */
export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
  atomicWriteSync(targetPath, JSON.stringify(data, null, 2));
}

/**
 * Append a line to a file with fsync for durability.
 * Opens, writes, fsyncs, then closes — ensures the line is on disk.
 */
export function durableAppendSync(targetPath: string, line: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  const fd = openSync(targetPath, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
