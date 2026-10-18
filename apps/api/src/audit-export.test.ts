import { describe, expect, test } from "bun:test";
import type { AuditRow } from "@orch/db";
import { auditCsv, csvCell } from "./audit-export";

describe("csvCell", () => {
  test("passes plain text through and writes nothing for null", () => {
    expect(csvCell("project.create")).toBe("project.create");
    expect(csvCell("2026-10-18T10:00:00.000Z")).toBe("2026-10-18T10:00:00.000Z");
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
  });

  test("quotes a separator, a quote or a line break, and doubles the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });

  test("makes a cell that a spreadsheet would run as a formula inert", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = csvCell(`${lead}SUM(A1)`);
      expect(out.replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    // only a leading character matters
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("a-b")).toBe("a-b");
  });
});

describe("auditCsv", () => {
  const row: AuditRow = {
    id: "0199-id",
    at: new Date("2026-10-18T10:00:00.000Z"),
    actorKind: "user",
    actorId: "u-1",
    action: "variable.create",
    resourceType: "variable",
    resourceId: null,
    organizationId: "o-1",
    projectId: null,
    metadata: { key: "A,B", count: 2 },
    requestId: "req-1",
    ip: "203.0.113.7",
  };

  test("is a header and a line per event, with the metadata as one JSON cell", () => {
    expect(auditCsv([row])).toBe(
      [
        "id,at,actor_kind,actor_id,action,resource_type,resource_id,organization_id,project_id,request_id,ip,metadata",
        '0199-id,2026-10-18T10:00:00.000Z,user,u-1,variable.create,variable,,o-1,,req-1,203.0.113.7,"{""key"":""A,B"",""count"":2}"',
        "",
      ].join("\r\n"),
    );
  });

  test("an empty export is the header alone", () => {
    expect(auditCsv([]).split("\r\n")).toEqual([
      "id,at,actor_kind,actor_id,action,resource_type,resource_id,organization_id,project_id,request_id,ip,metadata",
      "",
    ]);
  });
});
