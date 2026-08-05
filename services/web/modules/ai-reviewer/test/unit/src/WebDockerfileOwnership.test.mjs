import fs from "node:fs";

import { describe, expect, it } from "vitest";

const webDockerfileUrl = new URL("../../../../../Dockerfile", import.meta.url);

describe("web development image ownership", function () {
  it("copies the web source as the runtime node user", function () {
    const dockerfile = fs.readFileSync(webDockerfileUrl, "utf8");
    const webSourceCopies = dockerfile
      .split("\n")
      .filter((line) => line.endsWith("services/web/ /overleaf/services/web/"));

    expect(webSourceCopies).toEqual([
      "COPY --chown=node:node services/web/ /overleaf/services/web/",
      "COPY --chown=node:node services/web/ /overleaf/services/web/",
    ]);
  });
});
