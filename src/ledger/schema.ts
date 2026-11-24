/**
 * The one validator for `todo/v1` data: schema/todo-v1.schema.json, the file
 * the contract publishes, compiled with TypeBox (provided by pi). Replay and
 * tests use it, so a snapshot is valid here exactly when it is valid for any
 * reader that checks it against the published schema.
 */

import { readFileSync } from "node:fs";
import { Compile } from "typebox/compile";
import type { Task } from "../tool/types.ts";

const SCHEMA_URL = new URL("../../schema/todo-v1.schema.json", import.meta.url);

export const TODO_V1_SCHEMA: Record<string, unknown> = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));

const validator = Compile(TODO_V1_SCHEMA as never);

/** True when `value` is valid `todo/v1` entry data. */
export function isSnapshotV1(value: unknown): value is { v: 1; tasks: Task[]; nextId: number } {
	return validator.Check(value);
}
