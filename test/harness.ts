let passed = 0;
let failed = 0;
const failures: string[] = [];

export async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}\n    ${(err as Error).message ?? String(err)}`);
    console.log(`  FAIL ${name}`);
  }
}

export function eq<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n    expected: ${b}\n    actual:   ${a}`);
}

export function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function report(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
