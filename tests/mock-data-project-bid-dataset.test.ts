import { describe, expect, it } from "vitest";
import {
  BID_RECORD_ROWS,
  DATASET_DEFAULT_BIDS_PER_PROJECT,
  DATASET_DEFAULT_PROJECTS,
  generateProjectBidDataset,
  PROJECT_BID_DATASET_KIND,
  projectBidCountIssues,
  projectBidIssues,
  serializeProjectBidDataset,
} from "../entrypoints/tools/mock-data/lib/project-bid-dataset";
import { templateToFields } from "../entrypoints/tools/mock-data/lib/template-files";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";

function projectFields() {
  const template = TEMPLATES.find((item) => item.id === "project");
  if (!template) throw new Error("缺少招标项目模板");
  return templateToFields(template);
}

describe("项目 → 投标关联数据集", () => {
  it("两个项目各三条投标记录按项目顺序生成并共享父记录字段", () => {
    const dataset = generateProjectBidDataset(projectFields(), {
      seed: "project-bids",
      projectCount: 2,
      bidsPerProject: 3,
    });

    expect(dataset.projects).toHaveLength(2);
    expect(dataset.bids).toHaveLength(6);
    const codes = dataset.projects.map((project) => project.projectCode);
    expect(new Set(codes).size).toBe(2);

    let offset = 0;
    for (const group of dataset.groups) {
      expect(group.bids).toHaveLength(3);
      expect(group.bids).toEqual(dataset.bids.slice(offset, offset + 3));
      offset += 3;
      for (const bid of group.bids) {
        expect(bid.projectCode).toBe(group.project.projectCode);
        expect(bid.projectName).toBe(group.project.projectName);
        expect(bid.budget).toBe(group.project.budget);
      }
      expect(
        String(group.project.openBidTime) >
          String(group.project.registrationDeadline),
      ).toBe(true);
    }
  });

  it("相同 Seed 与数量得到相同预览、下载内容", () => {
    const fields = projectFields();
    const options = {
      seed: "repeatable",
      projectCount: 2,
      bidsPerProject: 3,
    };
    const first = generateProjectBidDataset(fields, options);
    const second = generateProjectBidDataset(fields, options);
    expect(second).toEqual(first);
    expect(serializeProjectBidDataset(second)).toBe(
      serializeProjectBidDataset(first),
    );

    const preview = generateProjectBidDataset(fields, {
      ...options,
      projectCount: 1,
      bidsPerProject: 1,
    });
    expect(preview.projects[0]).toEqual(first.projects[0]);
    expect(preview.bids[0]).toEqual(first.bids[0]);
  });

  it("完整 JSON 同时包含项目与投标记录", () => {
    const dataset = generateProjectBidDataset(projectFields(), {
      seed: "json",
    });
    const file = JSON.parse(serializeProjectBidDataset(dataset));
    expect(file.kind).toBe(PROJECT_BID_DATASET_KIND);
    expect(file.schemaVersion).toBe(1);
    expect(file.seed).toBe("json");
    expect(file.projects).toHaveLength(DATASET_DEFAULT_PROJECTS);
    expect(file.bids).toHaveLength(
      DATASET_DEFAULT_PROJECTS * DATASET_DEFAULT_BIDS_PER_PROJECT,
    );
    expect(file.summary).toEqual({
      projects: DATASET_DEFAULT_PROJECTS,
      bidsPerProject: DATASET_DEFAULT_BIDS_PER_PROJECT,
      bids: file.bids.length,
    });
  });

  it("缺少项目编号、名称或预算字段时指出需要载入的场景", () => {
    expect(projectBidIssues(projectFields())).toEqual([]);
    const issues = projectBidIssues([
      { id: "x", key: "name", type: "name", params: {} },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain("「招标项目」");
    expect(
      projectBidCountIssues({ projectCount: 1000, bidsPerProject: 1000 }),
    ).toEqual(["项目数与每项目投标记录数的乘积不能超过 100000"]);
    expect(
      projectBidCountIssues({ projectCount: 2, bidsPerProject: 3 }),
    ).toEqual([]);
  });

  it("投标记录模板覆盖企业、金额与状态字段", () => {
    const keys = BID_RECORD_ROWS.map((row) => row.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "projectCode",
        "projectName",
        "budget",
        "bidderName",
        "bidAmount",
        "bidStatus",
      ]),
    );
  });
});
