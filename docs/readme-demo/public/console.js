const ICONS = {
  grid: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  layers:
    '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  server:
    '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>',
  spark:
    '<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  arrow: '<path d="M6 18 18 6M6 6h12v12"/>',
  inbox: '<path d="M4 4h16v16H4zM4 14h4l2 3h4l2-3h4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
};

for (const element of document.querySelectorAll("[data-icon]")) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[element.dataset.icon] || ICONS.grid;
  element.append(svg);
}

const isTester = document.body.dataset.currentRole === "tester";
const heading = document.querySelector("#welcome-heading");
const name = document.querySelector(".identity b").textContent;
heading.textContent = isTester
  ? `${name}，今天也稳步向前。`
  : `${name}，交付尽在掌握。`;
document.querySelector("#role-description").textContent = isTester
  ? "验收测试 · 聚焦待办与回归，让每个问题都有回音。"
  : "交付管理员 · 掌握全局节奏，让每个环节都有回应。";
document.querySelector("#current-account-scope").textContent = isTester
  ? "验收任务 · 回归与结果提交"
  : "全部项目 · 发布与权限管理";
document.querySelector("#task-title").textContent = isTester
  ? "我的验收任务"
  : "待办与验收";
document.querySelector("#pending-count").innerHTML = isTester
  ? "03<span>项</span>"
  : "05<span>项</span>";
document.querySelector("#task-count").textContent = isTester ? "03" : "05";
document.querySelector("#pending-caption").textContent = isTester
  ? "1 项今日截止"
  : "2 项今日截止";
if (isTester) {
  document.querySelector("#task-list").innerHTML = `
    <label><input type="checkbox"><span><b>客户门户 · 回归用例复核</b><small>今天 16:00 · 测试验证</small></span><i class="priority-high">高</i></label>
    <label><input type="checkbox"><span><b>订单中心 · 验收结果确认</b><small>今天 18:00 · 发布验收</small></span><i>中</i></label>
    <label><input type="checkbox"><span><b>回归报告 · 同步测试证据</b><small>明天 10:00 · 团队协作</small></span><i>中</i></label>`;
  document.querySelector("#new-delivery").innerHTML = "<span>＋</span>提交验收";
}

const toast = document.querySelector("#demo-toast");
let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

for (const element of document.querySelectorAll("[data-toast]")) {
  element.addEventListener("click", () => showToast(element.dataset.toast));
}
document.querySelector("#export-button").addEventListener("click", () => {
  const content = `ShadeSheep 交付台 · 虚构演示周报\n当前身份：${name}\n进行中交付：12\n本周验收通过率：96.8%\n\n所有指标均为静态示例，非实时监控。`;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "shadesheep-demo-weekly.txt";
  link.click();
  URL.revokeObjectURL(url);
  showToast("演示周报已导出");
});
document.querySelector("#new-delivery").addEventListener("click", () => {
  showToast(
    isTester
      ? "验收任务已定位，请完成下方的待办清单"
      : "演示空间：可在「交付列车」查看进行中的交付",
  );
  document
    .querySelector("#acceptance")
    .scrollIntoView({ behavior: "smooth", block: "center" });
});
for (const link of document.querySelectorAll(".nav-link")) {
  link.addEventListener("click", () => {
    document.querySelector(".nav-link.active")?.classList.remove("active");
    link.classList.add("active");
  });
}

const identityButton = document.querySelector("#identity-button");
const identityMenu = document.querySelector("#identity-menu");
identityButton.addEventListener("click", () => {
  identityMenu.hidden = !identityMenu.hidden;
  identityButton.setAttribute("aria-expanded", String(!identityMenu.hidden));
});
document.addEventListener("click", (event) => {
  if (
    !identityMenu.contains(event.target) &&
    !identityButton.contains(event.target)
  ) {
    identityMenu.hidden = true;
    identityButton.setAttribute("aria-expanded", "false");
  }
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  await fetch("/api/session/logout", { method: "POST" });
  location.assign("/login");
});
