import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { activeProblemOf, activeProblemOccurrenceOf, modelSolutionForConclude, pendingProblemDismissalOf, needsContinuation, type LhMessage } from "../src/core/native-messages.ts";
import { preparePluginProblemType, pluginProblemForCall } from "../src/core/plugin-problems.ts";
import { admitPracticeProblem, concludeTool, type PracticeGate } from "../src/agent/tools/practice.ts";
import { masteryEvidence } from "../src/core/mastery.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";

const definition = preparePluginProblemType({ id: "code", label: "Coding problem", contractVersion: 1,
  tool: { toolName: "coding_problem", description: "Pose code" }, problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String() });
const input = { statement: "Implement f", mode: "composition", modelSolution: "The committed solution", payload: { starter: "function f() {}" } };
const snapshot = { protocolVersion: 1, problemId: "p-one", pluginId: "coding", typeId: "code", label: "Coding problem", contractVersion: 1,
  input, problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema, requiresSubmissionRefinement: false, requiresProcessing: true };
function pose(id = "call-p", error = false): LhMessage[] {
  return [ { id: "assistant-" + id, role: "assistant", content: [{ type: "toolCall", id, name: "coding_problem", arguments: input }] },
    { id: "result-" + id, role: "toolResult", toolCallId: id, toolName: "coding_problem", content: [{ type: "text", text: "Problem posed" }], isError: error, details: { pluginProblem: snapshot } } ] as unknown as LhMessage[];
}
const conclude = [ { id: "assistant-end", role: "assistant", content: [{ type: "toolCall", id: "call-end", name: "conclude", arguments: { outcome: "solved" } }] },
  { id: "result-end", role: "toolResult", toolCallId: "call-end", toolName: "conclude", content: [], isError: false } ] as unknown as LhMessage[];

test("acknowledged plugin poses share active state, exact occurrence and no-phantom-continuation semantics", () => {
  const messages = pose(), active = activeProblemOf(messages);
  assert.equal(active?.toolCallId, "call-p"); assert.deepEqual(active?.input, input);
  assert.equal(active?.pluginProblem?.problemId, "p-one");
  assert.deepEqual(activeProblemOccurrenceOf(messages), { messageId: "assistant-call-p", contentIndex: 0, toolCallId: "call-p", toolName: "coding_problem" });
  assert.equal(needsContinuation(messages), false);
  assert.equal(activeProblemOf(messages.slice(0,1)), null);
  assert.equal(activeProblemOf(pose("refused", true)), null);
});

test("native conclude closes a plugin problem and reveals its original committed solution", () => {
  const messages = [...pose(), ...conclude];
  assert.equal(activeProblemOf(messages), null);
  assert.equal(modelSolutionForConclude(messages, "call-end"), input.modelSolution);
});

test("plugin problems retain per-node mastery targets and record only the demonstrated knowledge", async () => {
  const gate: PracticeGate = { problemActive: false };
  const target = ["python-iterators", "python-generators"];
  const graphNodes = () => target.map(id => ({ id, name: id }));
  assert.equal(admitPracticeProblem(gate, { target }, graphNodes, "coding_problem"), undefined);
  assert.deepEqual(gate.targets, target);
  const finish = concludeTool(gate);
  const outcome = { outcome: "solved" as const, verdict: "One step checked", rung: null, missClass: null, retest: false };
  const refused = await finish.execute("missing-evidence", outcome);
  assert.equal(gate.problemActive, true, "multi-node coding problems must not be graded by one blanket result");
  assert.ok(JSON.stringify(refused).includes("knowledgeResults"));
  const graded = { ...outcome, knowledgeResults: [
    { nodeId: target[0]!, result: "passed" as const, reason: "Independently explained iterator exhaustion" },
    { nodeId: target[1]!, result: "unassessed" as const, reason: "Generator step was not tested" },
  ] };
  await finish.execute("call-end", graded);
  assert.equal(gate.problemActive, false);
  assert.deepEqual(gate.targets, []);
  const messages = [...pose(), ...conclude].map(m => ({ ...m, timestamp: 1_700_000_000_000 })) as LhMessage[];
  const posed = messages[1] as Extract<LhMessage, { role: "toolResult" }>;
  posed.details = JSON.parse(JSON.stringify({ pluginProblem: { ...snapshot, input: { ...input, target } } }));
  const start = messages[0] as Extract<LhMessage, { role: "assistant" }>;
  start.content = [{ type: "toolCall", id: "call-p", name: "coding_problem", arguments: { ...input, target } }];
  const end = messages[2] as Extract<LhMessage, { role: "assistant" }>;
  end.content = [{ type: "toolCall", id: "call-end", name: "conclude", arguments: graded }];
  const evidence = masteryEvidence({ id: "plugin-mastery", messages } as ChatRecord, new Set(target));
  assert.deepEqual(evidence.map(e => [e.nodeId, e.result]), [[target[0], "passed"]]);
});

test("a conclude reveal cannot join to a later pose in the same assistant batch", () => {
  const nextInput = { ...input, modelSolution: "Next problem's solution" };
  const batch = [{ id: "batch", role: "assistant", content: [
    { type: "toolCall", id: "call-end", name: "conclude", arguments: { outcome: "solved" } },
    { type: "toolCall", id: "next", name: "coding_problem", arguments: nextInput },
  ] }, conclude[1], { id: "next-ack", role: "toolResult", toolCallId: "next", toolName: "coding_problem", content: [], isError: false,
    details: { pluginProblem: { ...snapshot, problemId: "next-problem", input: nextInput } } }] as unknown as LhMessage[];
  const messages = [...pose(), ...batch];
  assert.equal(modelSolutionForConclude(messages, "call-end"), input.modelSolution);
  assert.equal(activeProblemOf(messages)?.pluginProblem?.problemId, "next-problem");
});

test("plugin poses supersede dismissed-problem markers without depending on a live registry", () => {
  const marker = { id: "dismissed", role: "custom", customType: "problem-dismissed", content: "", details: { problemCallId: "old" }, timestamp: 0 } as LhMessage;
  assert.equal(pendingProblemDismissalOf([marker]), "old");
  assert.equal(pendingProblemDismissalOf([marker, ...pose()]), null);
  assert.equal(activeProblemOf([...pose(), marker]), null);
});

test("pose details cannot bind to another call occurrence or an old repeated call id", () => {
  const messages = pose(), occurrence = { messageId: "assistant-call-p", contentIndex: 0, toolCallId: "call-p", toolName: "coding_problem" };
  assert.ok(pluginProblemForCall(messages, occurrence));
  assert.equal(pluginProblemForCall(messages, { ...occurrence, toolName: "other" }), null);
  const newer = { id: "new-assistant", role: "assistant", content: [{ type: "toolCall", id: "call-p", name: "coding_problem", arguments: input }] } as unknown as LhMessage;
  assert.equal(pluginProblemForCall([...messages, newer], { ...occurrence, messageId: "new-assistant" }), null);
});
