import { parse, type Node } from "acorn";
import { full } from "acorn-walk";
import type { ToolRegistry } from "./tools.js";

export type ArgClass = "literal" | "pure" | "tool" | "tainted";
export type Decision = "speculate" | "defer" | "refuse";

export interface AnalyzedCall {
  id: string;
  tool: string;
  occurrence: number;
  argClass: ArgClass;
  decision: Decision;
  reason: string;
  dependsOn: string[];
  args: unknown | null;
  sourceLoc: { line: number; column: number };
}

export interface AnalyzedPlan {
  calls: AnalyzedCall[];
  order: string[];
  errors: string[];
}

type AstNode = Node & Record<string, unknown>;

interface ValueInfo {
  class: ArgClass;
  dependsOn: string[];
  known: boolean;
  value: unknown;
  taint: { identifier: string; line: number } | null;
  expression?: AstNode | undefined;
}

interface VisitContext {
  predicate: ValueInfo | null;
  loopTaintLine: number | null;
}

interface RuntimeCall {
  args: AstNode;
  scope: Map<string, ValueInfo>;
  callIds: Map<AstNode, string>;
}

const runtimePlans = new WeakMap<AnalyzedPlan, Map<string, RuntimeCall>>();

const rank: Record<ArgClass, number> = { literal: 0, pure: 1, tool: 2, tainted: 3 };

const literal = (value: unknown): ValueInfo => ({
  class: "literal",
  dependsOn: [],
  known: true,
  value,
  taint: null,
});

const pure = (value: unknown, known: boolean): ValueInfo => ({
  class: "pure",
  dependsOn: [],
  known,
  value,
  taint: null,
});

const tainted = (identifier: string, line: number): ValueInfo => ({
  class: "tainted",
  dependsOn: [],
  known: false,
  value: undefined,
  taint: { identifier, line },
});

function nodeLine(node: AstNode): number {
  return node.loc?.start.line ?? 1;
}

function nodeLoc(node: AstNode): { line: number; column: number } {
  return { line: node.loc?.start.line ?? 1, column: node.loc?.start.column ?? 0 };
}

function identifierName(node: AstNode | null | undefined): string | null {
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function merge(values: ValueInfo[], fallback: ArgClass = "literal"): ValueInfo {
  if (values.length === 0) return fallback === "pure" ? pure(undefined, false) : literal(undefined);
  const worst = values.reduce((current, value) =>
    rank[value.class] > rank[current.class] ? value : current,
  );
  const dependsOn = [...new Set(values.flatMap((value) => value.dependsOn))];
  if (worst.class === "tainted") {
    return {
      class: "tainted",
      dependsOn,
      known: false,
      value: undefined,
      taint: values.find((value) => value.taint)?.taint ?? null,
    };
  }
  if (worst.class === "tool") {
    return { class: "tool", dependsOn, known: false, value: undefined, taint: null };
  }
  return {
    class: worst.class,
    dependsOn,
    known: values.every((value) => value.known),
    value: undefined,
    taint: null,
  };
}

function memberName(node: AstNode): string | null {
  if (node.type !== "MemberExpression") return null;
  const object = identifierName(node.object as AstNode);
  const property = node.computed
    ? (node.property as AstNode).type === "Literal" && typeof (node.property as AstNode).value === "string"
      ? (node.property as AstNode).value
      : null
    : identifierName(node.property as AstNode);
  return object && property ? object + "." + property : null;
}

function isArrayMethod(node: AstNode): boolean {
  if (node.type !== "MemberExpression") return false;
  const property = node.computed
    ? (node.property as AstNode).value
    : identifierName(node.property as AstNode);
  return typeof property === "string" && ["map", "filter", "slice", "join", "concat", "includes"].includes(property);
}

function staticMember(value: unknown, property: unknown): unknown {
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "string")) {
    return undefined;
  }
  if (typeof property !== "string" && typeof property !== "number") return undefined;
  if (property === "length" && (Array.isArray(value) || typeof value === "string")) return value.length;
  if (Array.isArray(value) && typeof property === "number") return value[property];
  if (typeof value === "object" && Object.prototype.hasOwnProperty.call(value, property)) {
    return (value as Record<string, unknown>)[property];
  }
  return undefined;
}

function evaluateBuiltin(name: string, receiver: unknown, args: unknown[]): { known: boolean; value: unknown } {
  try {
    switch (name) {
      case "String": return { known: true, value: String(args[0]) };
      case "Number": return { known: true, value: Number(args[0]) };
      case "Boolean": return { known: true, value: Boolean(args[0]) };
      case "JSON.parse": return { known: true, value: JSON.parse(String(args[0])) };
      case "JSON.stringify": return { known: true, value: JSON.stringify(args[0]) };
      case "Array.isArray": return { known: true, value: Array.isArray(args[0]) };
      case "slice": return { known: true, value: (receiver as unknown[]).slice(...args.map(Number)) };
      case "join": return { known: true, value: (receiver as unknown[]).join(args[0] as string | undefined) };
      case "concat": return { known: true, value: (receiver as unknown[]).concat(...args) };
      case "includes": return { known: true, value: (receiver as unknown[]).includes(args[0]) };
      case "map": {
        const mapper = args[0] === "String" ? String : args[0] === "Number" ? Number : args[0] === "Boolean" ? Boolean : null;
        return mapper ? { known: true, value: (receiver as unknown[]).map((value) => mapper(value)) } : { known: false, value: undefined };
      }
      case "filter": return args[0] === "Boolean"
        ? { known: true, value: (receiver as unknown[]).filter(Boolean) }
        : { known: false, value: undefined };
      default: return { known: false, value: undefined };
    }
  } catch {
    return { known: false, value: undefined };
  }
}

function runtimeBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case "+": return (left as never) + (right as never);
    case "-": return Number(left) - Number(right);
    case "*": return Number(left) * Number(right);
    case "/": return Number(left) / Number(right);
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return left == right; // eslint-disable-line eqeqeq
    case "!=": return left != right; // eslint-disable-line eqeqeq
    case "<": return (left as never) < (right as never);
    case "<=": return (left as never) <= (right as never);
    case ">": return (left as never) > (right as never);
    case ">=": return (left as never) >= (right as never);
    case "&&": return left ? right : left;
    case "||": return left ? left : right;
    default: return undefined;
  }
}

function normalizeToolCallArguments(args: AstNode[], paramNames: string[]): AstNode {
  if (args.length === 1 && args[0]?.type === "ObjectExpression") return args[0];
  return {
    type: "ObjectExpression",
    properties: args.slice(0, paramNames.length).map((argument, index) => ({
      type: "Property",
      key: { type: "Identifier", name: paramNames[index] },
      value: argument,
      kind: "init",
      method: false,
      computed: false,
      shorthand: false,
    })),
  } as unknown as AstNode;
}

export function resolveAnalyzedCallArgs(
  plan: AnalyzedPlan,
  id: string,
  results: ReadonlyMap<string, unknown>,
): unknown | null {
  const runtime = runtimePlans.get(plan)?.get(id);
  if (!runtime) return null;
  const evaluating = new Set<AstNode>();
  const evaluate = (node: AstNode, scope: Map<string, ValueInfo>): unknown => {
    if (evaluating.has(node)) return undefined;
    evaluating.add(node);
    try {
      switch (node.type) {
        case "Literal": return node.value;
        case "Identifier": {
          const name = identifierName(node) ?? "";
          const binding = scope.get(name);
          if (!binding && ["String", "Number", "Boolean"].includes(name)) return name;
          if (!binding) return undefined;
          if (binding.expression) return evaluate(binding.expression, scope);
          return binding.dependsOn.length === 1 ? results.get(binding.dependsOn[0] ?? "") : binding.value;
        }
        case "AwaitExpression": return evaluate(node.argument as AstNode, scope);
        case "TemplateLiteral": {
          const quasis = node.quasis as AstNode[];
          const expressions = node.expressions as AstNode[];
          return quasis.map((quasi, index) =>
            String((quasi.value as { cooked?: string }).cooked ?? "") + (index < expressions.length ? String(evaluate(expressions[index] as AstNode, scope)) : ""),
          ).join("");
        }
        case "ArrayExpression": return (node.elements as Array<AstNode | null>).map((item) => item ? evaluate(item, scope) : null);
        case "ObjectExpression": {
          const value: Record<string, unknown> = {};
          for (const property of node.properties as AstNode[]) {
            const key = property.key as AstNode;
            const name = key.type === "Identifier" ? key.name : key.value;
            if (typeof name === "string" || typeof name === "number") value[String(name)] = evaluate(property.value as AstNode, scope);
          }
          return value;
        }
        case "MemberExpression": {
          const object = evaluate(node.object as AstNode, scope);
          const property = node.computed ? evaluate(node.property as AstNode, scope) : identifierName(node.property as AstNode);
          return staticMember(object, property);
        }
        case "BinaryExpression":
        case "LogicalExpression": return runtimeBinary(node.operator as string, evaluate(node.left as AstNode, scope), evaluate(node.right as AstNode, scope));
        case "CallExpression": {
          const toolId = runtime.callIds.get(node);
          if (toolId) return results.get(toolId);
          const callee = node.callee as AstNode;
          const builtin = memberName(callee) ?? identifierName(callee);
          const args = (node.arguments as AstNode[]).map((argument) => evaluate(argument, scope));
          const receiver = callee.type === "MemberExpression" ? evaluate(callee.object as AstNode, scope) : undefined;
          return evaluateBuiltin(isArrayMethod(callee) ? (identifierName(callee.property as AstNode) ?? "") : (builtin ?? ""), receiver, args).value;
        }
        default: return undefined;
      }
    } finally {
      evaluating.delete(node);
    }
  };
  return evaluate(runtime.args, runtime.scope) ?? null;
}

export function analyzePlan(source: string, registry: ToolRegistry): AnalyzedPlan {
  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = /\((\d+):\d+\)/.exec(message)?.[1] ?? "1";
    return { calls: [], order: [], errors: ["grammar error at line " + line + ": " + message] };
  }

  const calls: AnalyzedCall[] = [];
  const errors = new Set<string>();
  const occurrences = new Map<string, number>();
  const env = new Map<string, ValueInfo>();
  const runtimeCalls = new Map<string, RuntimeCall>();
  const callIds = new Map<AstNode, string>();
  const error = (name: string, node: AstNode): void => {
    errors.add("grammar error: " + name + " at line " + nodeLine(node));
  };

  full(program, (node) => {
    const ast = node as AstNode;
    const forbidden: Record<string, string> = {
      ImportDeclaration: "import",
      ImportExpression: "import",
      ExportNamedDeclaration: "export",
      ExportDefaultDeclaration: "export",
      FunctionDeclaration: "function",
      FunctionExpression: "function",
      ArrowFunctionExpression: "arrow function",
      ClassDeclaration: "class",
      ClassExpression: "class",
      TryStatement: "try",
      CatchClause: "catch",
      WhileStatement: "while",
      DoWhileStatement: "while",
      ThrowStatement: "throw",
      NewExpression: "new",
      AssignmentExpression: "assignment",
      UpdateExpression: "assignment",
    };
    const name = forbidden[ast.type];
    if (name) error(name, ast);
  });

  const classify = (node: AstNode, scope: Map<string, ValueInfo>, context: VisitContext): ValueInfo => {
    switch (node.type) {
      case "Literal": {
        if (node.regex || typeof node.value === "bigint") {
          error("literal", node);
          return tainted("literal", nodeLine(node));
        }
        return literal(node.value);
      }
      case "Identifier": {
        const name = identifierName(node) ?? "unknown";
        if (["require", "globalThis", "eval", "Function", "fetch", "setTimeout"].includes(name)) {
          error(name, node);
        }
        if (["String", "Number", "Boolean"].includes(name)) return pure(name, true);
        return scope.get(name) ?? tainted(name, nodeLine(node));
      }
      case "TemplateLiteral": {
        const expressions = (node.expressions as AstNode[]).map((expression) => classify(expression, scope, context));
        const combined = merge(expressions);
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        const quasis = node.quasis as AstNode[];
        if (expressions.every((expression) => expression.known)) {
          let value = "";
          for (let index = 0; index < quasis.length; index += 1) {
            value += String((quasis[index]?.value as { cooked?: string }).cooked ?? "");
            if (index < expressions.length) value += String(expressions[index]?.value);
          }
          return combined.class === "literal" ? literal(value) : pure(value, true);
        }
        return pure(undefined, false);
      }
      case "ArrayExpression": {
        const values = (node.elements as Array<AstNode | null>).map((element) =>
          element ? classify(element, scope, context) : literal(null),
        );
        const combined = merge(values);
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        const known = values.every((value) => value.known);
        const value = known ? values.map((item) => item.value) : undefined;
        return combined.class === "literal" ? literal(value) : pure(value, known);
      }
      case "ObjectExpression": {
        const properties = node.properties as AstNode[];
        const values = properties.map((property) => {
          if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) {
            error("object property", property);
            return tainted("object", nodeLine(property));
          }
          return classify(property.value as AstNode, scope, context);
        });
        const combined = merge(values);
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        const known = values.every((value) => value.known);
        const value: Record<string, unknown> = {};
        if (known) {
          for (const [index, property] of properties.entries()) {
            const key = property.key as AstNode;
            const keyValue = key.type === "Identifier" ? key.name : key.value;
            if (typeof keyValue !== "string" && typeof keyValue !== "number") {
              error("object key", key);
              return tainted("object", nodeLine(key));
            }
            value[String(keyValue)] = values[index]?.value;
          }
        }
        return combined.class === "literal" ? literal(value) : pure(value, known);
      }
      case "UnaryExpression":
        error("unary operator", node);
        return tainted("unary operator", nodeLine(node));
      case "BinaryExpression":
      case "LogicalExpression": {
        const left = classify(node.left as AstNode, scope, context);
        const right = classify(node.right as AstNode, scope, context);
        const combined = merge([left, right]);
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        if (left.known && right.known) {
          try {
            const operator = node.operator as string;
            const value = operator === "+" ? (left.value as never) + (right.value as never)
              : operator === "-" ? Number(left.value) - Number(right.value)
              : operator === "*" ? Number(left.value) * Number(right.value)
              : operator === "/" ? Number(left.value) / Number(right.value)
              : operator === "===" ? left.value === right.value
              : operator === "!==" ? left.value !== right.value
              : operator === "==" ? left.value == right.value // eslint-disable-line eqeqeq
              : operator === "!=" ? left.value != right.value // eslint-disable-line eqeqeq
              : operator === "<" ? (left.value as never) < (right.value as never)
              : operator === "<=" ? (left.value as never) <= (right.value as never)
              : operator === ">" ? (left.value as never) > (right.value as never)
              : operator === ">=" ? (left.value as never) >= (right.value as never)
              : operator === "&&" ? (left.value ? right.value : left.value)
              : operator === "||" ? (left.value ? left.value : right.value) : undefined;
            return pure(value, value !== undefined);
          } catch {
            return pure(undefined, false);
          }
        }
        return pure(undefined, false);
      }
      case "MemberExpression": {
        const name = memberName(node);
        if (name === "process.env") return tainted(name, nodeLine(node));
        if (name === "Math.random" || name === "Date.now") return tainted(name, nodeLine(node));
        const object = classify(node.object as AstNode, scope, context);
        const property = node.computed ? classify(node.property as AstNode, scope, context) : literal(identifierName(node.property as AstNode));
        const combined = merge([object, property]);
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        if (object.known && property.known) {
          const value = staticMember(object.value, property.value);
          return combined.class === "literal" ? literal(value) : pure(value, value !== undefined);
        }
        return pure(undefined, false);
      }
      case "CallExpression": {
        const callee = node.callee as AstNode;
        const tool = identifierName(callee);
        const builtin = memberName(callee) ?? tool;
        const isBuiltin = builtin !== null && ["JSON.parse", "JSON.stringify", "String", "Number", "Boolean", "Array.isArray"].includes(builtin);
        const arrayMethod = isArrayMethod(callee);
        if (builtin === "Math.random" || builtin === "Date.now") {
          return tainted(builtin, nodeLine(node));
        }
        if (tool && registry.get(tool)) {
          const spec = registry.get(tool);
          if (!spec) throw new Error("Registered tool is unavailable: " + tool);
          const rawArgs = node.arguments as AstNode[];
          if (rawArgs.length > spec.paramNames.length && !(rawArgs.length === 1 && rawArgs[0]?.type === "ObjectExpression")) {
            errors.add(
              "grammar error: too many arguments for " + tool + ": expected " + spec.paramNames.length + ", got " + rawArgs.length + " at line " + nodeLine(node),
            );
          }
          const normalizedArgs = normalizeToolCallArguments(rawArgs, spec.paramNames);
          const argumentInfo = classify(normalizedArgs, scope, context);
          const id = "c" + calls.length;
          const occurrence = occurrences.get(tool) ?? 0;
          occurrences.set(tool, occurrence + 1);
          const predicateUnresolved = context.predicate !== null && rank[context.predicate.class] > rank.pure;
          const reason = context.loopTaintLine !== null
            ? "loop iterable is tainted at line " + context.loopTaintLine
            : argumentInfo.class === "tainted"
              ? "tainted argument: " + (argumentInfo.taint?.identifier ?? "unknown") + " at line " + (argumentInfo.taint?.line ?? nodeLine(node))
              : predicateUnresolved && !spec?.sideEffectFree
                ? "side-effecting tool under unresolved predicate at line " + nodeLine(node)
                : !spec?.speculatable
                  ? "tool " + tool + " is not speculatable"
                  : "args are " + argumentInfo.class;
          const decision: Decision = context.loopTaintLine !== null || (predicateUnresolved && !spec?.sideEffectFree) || !spec?.speculatable
            ? "defer"
            : argumentInfo.class === "tainted" ? "refuse" : "speculate";
          calls.push({
            id,
            tool,
            occurrence,
            argClass: argumentInfo.class,
            decision,
            reason,
            dependsOn: argumentInfo.dependsOn,
            args: argumentInfo.known ? argumentInfo.value : null,
            sourceLoc: nodeLoc(node),
          });
          callIds.set(node, id);
          runtimeCalls.set(id, { args: normalizedArgs, scope: new Map(scope), callIds: new Map(callIds) });
          return { class: "tool", dependsOn: [id], known: false, value: undefined, taint: null };
        }
        const args = (node.arguments as AstNode[]).map((argument) => classify(argument, scope, context));
        if (tool && ["require", "eval", "Function", "fetch", "setTimeout"].includes(tool)) {
          error(tool, node);
          return tainted(tool, nodeLine(node));
        }
        if (!isBuiltin && !arrayMethod) {
          const name = tool ?? memberName(callee) ?? "call";
          error(name, node);
          return tainted(name, nodeLine(node));
        }
        const receiver = arrayMethod ? classify(callee.object as AstNode, scope, context) : literal(undefined);
        if (arrayMethod && (!receiver.known || !Array.isArray(receiver.value))) {
          error("Array.prototype." + (identifierName(callee.property as AstNode) ?? "method"), node);
          return tainted("Array.prototype", nodeLine(node));
        }
        const combined = merge([...args, receiver], "pure");
        if (combined.class === "tainted" || combined.class === "tool") return combined;
        const known = receiver.known && args.every((argument) => argument.known);
        const result = known ? evaluateBuiltin(arrayMethod ? (identifierName(callee.property as AstNode) ?? "") : (builtin ?? ""), receiver.value, args.map((argument) => argument.value)) : { known: false, value: undefined };
        return pure(result.value, result.known);
      }
      case "AwaitExpression": return classify(node.argument as AstNode, scope, context);
      default:
        error(node.type, node);
        return tainted(node.type, nodeLine(node));
    }
  };

  const visitStatements = (statements: AstNode[], scope: Map<string, ValueInfo>, context: VisitContext): void => {
    for (const statement of statements) visitStatement(statement, scope, context);
  };

  const visitStatement = (statement: AstNode, scope: Map<string, ValueInfo>, context: VisitContext): void => {
    switch (statement.type) {
      case "EmptyStatement": return;
      case "ExpressionStatement":
        classify(statement.expression as AstNode, scope, context);
        return;
      case "VariableDeclaration": {
        if (statement.kind !== "const" && statement.kind !== "let") error(String(statement.kind), statement);
        for (const declaration of statement.declarations as AstNode[]) {
          const name = identifierName(declaration.id as AstNode);
          if (!name) {
            error("binding", declaration);
            continue;
          }
          if (scope.has(name)) error("assignment to " + name, declaration);
          const value = declaration.init ? classify(declaration.init as AstNode, scope, context) : tainted(name, nodeLine(declaration));
          scope.set(name, declaration.init ? { ...value, expression: declaration.init as AstNode } : value);
        }
        return;
      }
      case "BlockStatement":
        visitStatements(statement.body as AstNode[], scope, context);
        return;
      case "IfStatement": {
        const predicate = classify(statement.test as AstNode, scope, context);
        if ((predicate.class === "literal" || predicate.class === "pure") && predicate.known) {
          if (predicate.value) visitStatement(statement.consequent as AstNode, scope, { ...context, predicate });
          else if (statement.alternate) visitStatement(statement.alternate as AstNode, scope, { ...context, predicate });
          return;
        }
        const before = new Map(scope);
        const consequent = new Map(before);
        visitStatement(statement.consequent as AstNode, consequent, { ...context, predicate });
        const alternate = new Map(before);
        if (statement.alternate) visitStatement(statement.alternate as AstNode, alternate, { ...context, predicate });
        const names = new Set([...consequent.keys(), ...alternate.keys()]);
        for (const name of names) {
          const left = consequent.get(name);
          const right = alternate.get(name);
          if (!left || !right || left.class !== right.class || left.known !== right.known || left.value !== right.value) {
            scope.set(name, tainted(name, nodeLine(statement)));
          } else {
            scope.set(name, left);
          }
        }
        return;
      }
      case "ForOfStatement": {
        const declaration = statement.left as AstNode;
        const declarations = declaration.type === "VariableDeclaration" ? declaration.declarations as AstNode[] : [];
        const name = declarations.length === 1 ? identifierName(declarations[0]?.id as AstNode) : null;
        if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || !name) {
          error("for binding", declaration);
          return;
        }
        const iterable = classify(statement.right as AstNode, scope, context);
        if ((iterable.class === "literal" || iterable.class === "pure") && iterable.known && Array.isArray(iterable.value)) {
          for (const item of iterable.value) {
            const loopScope = new Map(scope);
            loopScope.set(name, literal(item));
            visitStatement(statement.body as AstNode, loopScope, context);
          }
        } else {
          const loopScope = new Map(scope);
          loopScope.set(name, tainted(name, nodeLine(statement.right as AstNode)));
          visitStatement(statement.body as AstNode, loopScope, { ...context, loopTaintLine: nodeLine(statement.right as AstNode) });
        }
        return;
      }
      case "ReturnStatement":
        if (statement.argument) classify(statement.argument as AstNode, scope, context);
        return;
      default:
        error(statement.type, statement);
    }
  };

  visitStatements(program.body as AstNode[], env, { predicate: null, loopTaintLine: null });
  const byId = new Map(calls.map((call) => [call.id, call]));
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    order.push(id);
  };
  for (const call of calls) visit(call.id);
  const plan = { calls, order, errors: [...errors] };
  runtimePlans.set(plan, runtimeCalls);
  return plan;
}
