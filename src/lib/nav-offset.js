// 站台 Navbar symbol 是 position:fixed，會蓋住 #od-kol / #od-kol-result 頂部；量它的可見高度補成 padding-top。
// .w-nav 容器本身量到只有 30px、內層 wrapper 才是 84px → 取容器與子元素的最大高度。

export function fixedNavOffset({ position, height } = {}) {
  return position === "fixed" && height > 0 ? Math.ceil(height) : 0;
}

export function measureNav(nav, getStyle) {
  if (!nav) return { position: "", height: 0 };
  const heights = [nav, ...Array.from(nav.children || [])].map((el) => el.getBoundingClientRect().height);
  return { position: getStyle(nav).position, height: Math.max(0, ...heights) };
}

// basePx = 該 root 原本 CSS 的 padding-top；回傳補了多少（0 = 沒動）
export function applyNavOffset(root, { doc = document, win = window, basePx = 0 } = {}) {
  const off = fixedNavOffset(measureNav(doc.querySelector(".w-nav"), (el) => win.getComputedStyle(el)));
  if (off) root.style.paddingTop = `${basePx + off}px`;
  return off;
}
