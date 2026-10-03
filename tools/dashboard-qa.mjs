// Behavioural QA for the dashboard webview, run against a preview page built
// by tools/make-dashboard-preview.py.
//
//   python tools/make-dashboard-preview.py
//   node <browser-automation-skill>/browser.mjs \
//     "file:///<abs>/tools/preview/dashboard-dark.html" --script tools/dashboard-qa.mjs
//
// Asserts the things a screenshot cannot: tooltip contents, that one filter row
// scopes the charts, the table and the KPI tiles together, sorting, and the
// empty state. `page` is a Playwright Page.

export default async function run(page) {
  const out = {};

  // The context chart, located by its heading rather than by nth-child, so the
  // assertion survives cards being reordered.
  const contextChartRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".card")]
        .find((c) => c.querySelector("h2")?.textContent.startsWith("Context usage"))
        .querySelectorAll(".rowName .n").length
    );

  out.rowsShown = await contextChartRows();

  // Hover tooltip must carry the values, not just repeat the label.
  await page.locator(".chart .meter").first().hover();
  await page.waitForTimeout(150);
  out.hoverTooltip = await page.evaluate(() => {
    const t = document.getElementById("tip");
    return {
      visible: getComputedStyle(t).opacity !== "0",
      text: t.innerText.replace(/\n/g, " | "),
    };
  });

  // Keyboard focus must show the same thing as hover.
  await page.evaluate(() => document.querySelector(".rowName").focus());
  await page.waitForTimeout(120);
  out.focusShowsTooltip = await page.evaluate(
    () => getComputedStyle(document.getElementById("tip")).opacity !== "0"
  );

  // One filter row scopes everything below it.
  await page.getByRole("button", { name: /^Warning/ }).click();
  await page.waitForTimeout(120);
  out.warningFilter = {
    chartRows: await contextChartRows(),
    tableRows: await page.evaluate(() => document.querySelectorAll("#rows tr").length),
    kpiSessions: await page.evaluate(() => document.querySelector(".kpi .value").textContent),
  };

  await page.getByRole("button", { name: /^All/ }).click();
  await page.fill("#search", "nbcserv");
  await page.waitForTimeout(150);
  out.search = await page.evaluate(() => ({
    tableRows: document.querySelectorAll("#rows tr").length,
    first: document.querySelector("#rows tr td div")?.textContent,
  }));

  await page.fill("#search", "");
  await page.locator('th[data-k="messages"]').click();
  await page.waitForTimeout(120);
  out.sortedByMessages = await page.evaluate(() =>
    [...document.querySelectorAll("#rows tr td:nth-child(4)")].map((td) => td.textContent).slice(0, 3)
  );

  await page.fill("#search", "zzzz-no-match");
  await page.waitForTimeout(150);
  out.emptyState = await page.evaluate(() => ({
    chart: document.querySelector(".card .empty")?.textContent,
    table: document.querySelector("#rows .empty")?.textContent,
    kpi: document.querySelector(".kpi .value")?.textContent,
  }));

  out.noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );

  return out;
}
