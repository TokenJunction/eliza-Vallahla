import { expect, test } from "bun:test";
import { buildTasksSucceeded } from "../../build.ts";

test("requires both bundling and declaration generation to succeed", () => {
  expect(buildTasksSucceeded({ success: true }, { success: true })).toBe(true);
  expect(buildTasksSucceeded({ success: false }, { success: true })).toBe(
    false,
  );
  expect(buildTasksSucceeded({ success: true }, { success: false })).toBe(
    false,
  );
});
