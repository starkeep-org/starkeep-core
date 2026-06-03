/**
 * Shared IAM types and CloudFormation YAML rendering utilities.
 * Used by the bootstrap template generator and policy builders.
 */

export type CfnValue =
  | string
  | { Sub: string }
  | { GetAtt: string }
  | { Ref: string };

export interface IamStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: CfnValue | CfnValue[];
  Condition?: Record<string, Record<string, CfnValue | CfnValue[]>>;
}

export function renderStatementsYaml(
  statements: IamStatement[],
  indentSpaces: number,
): string {
  const indent = " ".repeat(indentSpaces);
  const lines: string[] = [];

  for (const s of statements) {
    lines.push(`${indent}- Sid: ${s.Sid}`);
    lines.push(`${indent}  Effect: ${s.Effect}`);
    lines.push(...renderActionOrResource("Action", s.Action, indent + "  "));
    lines.push(...renderActionOrResource("Resource", s.Resource, indent + "  "));
    if (s.Condition) {
      lines.push(`${indent}  Condition:`);
      for (const [op, kvs] of Object.entries(s.Condition)) {
        lines.push(`${indent}    ${op}:`);
        for (const [k, v] of Object.entries(kvs)) {
          if (Array.isArray(v)) {
            lines.push(`${indent}      ${quoteKey(k)}:`);
            for (const item of v) {
              lines.push(`${indent}        - ${renderCfnScalar(item)}`);
            }
          } else {
            lines.push(`${indent}      ${quoteKey(k)}: ${renderCfnScalar(v)}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

function renderActionOrResource(
  key: "Action" | "Resource",
  value: string | CfnValue | (string | CfnValue)[],
  indent: string,
): string[] {
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return [`${indent}${key}: ${renderCfnScalar(value[0]!)}`];
    }
    const lines = [`${indent}${key}:`];
    for (const item of value) {
      lines.push(`${indent}  - ${renderCfnScalar(item)}`);
    }
    return lines;
  }
  return [`${indent}${key}: ${renderCfnScalar(value)}`];
}

function renderCfnScalar(v: CfnValue): string {
  if (typeof v === "string") return quoteScalar(v);
  if ("Sub" in v) return `!Sub '${escapeSingleQuoted(v.Sub)}'`;
  if ("GetAtt" in v) return `!GetAtt ${v.GetAtt}`;
  if ("Ref" in v) return `!Ref ${v.Ref}`;
  throw new Error(`Unsupported CfnValue: ${JSON.stringify(v)}`);
}

function quoteScalar(s: string): string {
  return `'${escapeSingleQuoted(s)}'`;
}

function quoteKey(k: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k)) return k;
  return `'${escapeSingleQuoted(k)}'`;
}

function escapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}
