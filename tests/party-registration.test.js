import { describe, it, expect } from "vitest";
import {
  ageOn,
  ageError,
  basePrice,
  buildRegistrationPayload,
  buildWaitlistPayload,
  eligibilityView,
  genderOpen,
  isValidPhone,
  parseUtm,
  remainingText,
  validateForm,
  validateWaitlist,
  verifiedPrice,
} from "../src/party-registration.js";

const SESSION = {
  id: 9,
  date: "2026-12-13",
  min_age: 45,
  max_age: 65,
  price_male_base: 1280,
  price_male_early: 780,
  price_male_verified: 980,
  price_female_base: 980,
  price_female_early: 580,
  price_female_verified: 780,
  early_bird_deadline: "2026-12-06T15:59:59Z", // 12/6 23:59:59 台北
  female_early_extend_until: "2026-12-11T15:59:59Z",
  female_early_extended: true,
  is_male_open: false,
  is_female_open: true,
  remaining_male: 0,
  remaining_female: 12,
};

const FORM = {
  name: "小橘",
  gender: "male",
  birth_date: "1970-05-01",
  phone: "0912345678",
  email: "a@example.com",
  city: "桃園",
  interests: ["爬山", "咖啡", "日本旅行"],
  photo_consent: "ok",
  source: "smile_group",
  single_declared: true,
  terms_agreed: true,
};

describe("年齡", () => {
  it("以活動日算實歲", () => {
    expect(ageOn("1981-12-13", "2026-12-13")).toBe(45);
    expect(ageOn("1981-12-14", "2026-12-13")).toBe(44);
  });
  it("45–65 邊界", () => {
    expect(ageError("1981-12-13", SESSION)).toBe("");
    expect(ageError("1981-12-14", SESSION)).toBe("本場活動限 45–65 歲");
    expect(ageError("1960-12-14", SESSION)).toBe("");
    expect(ageError("1960-12-13", SESSION)).toBe("本場活動限 45–65 歲");
    expect(ageError("", SESSION)).toBe("請填寫出生年月日");
  });
});

describe("價格顯示", () => {
  it("早鳥截止前後", () => {
    expect(verifiedPrice(SESSION, "male", new Date("2026-12-06T15:59:59Z"))).toBe(780);
    expect(verifiedPrice(SESSION, "male", new Date("2026-12-06T16:00:00Z"))).toBe(980);
  });
  it("女生延長期間仍是早鳥價、延長結束後是驗證價", () => {
    expect(verifiedPrice(SESSION, "female", new Date("2026-12-08T00:00:00Z"))).toBe(580);
    expect(verifiedPrice(SESSION, "female", new Date("2026-12-12T00:00:00Z"))).toBe(780);
    expect(verifiedPrice({ ...SESSION, female_early_extended: false }, "female", new Date("2026-12-08T00:00:00Z"))).toBe(780);
  });
  it("原價", () => {
    expect(basePrice(SESSION, "male")).toBe(1280);
    expect(basePrice(SESSION, "female")).toBe(980);
  });
});

describe("eligibilityView", () => {
  it("eligible 直接付款", () => {
    const v = eligibilityView({ status: "eligible", price: 980 }, 300);
    expect(v.choice).toBe("pay");
    expect(v.message).toContain("NT$980");
  });
  it("缺人臉＋單身都列出", () => {
    const v = eligibilityView({ status: "face_not_passed", face_passed: false, single_status: "not_submitted" }, 300);
    expect(v.message).toContain("人臉驗證、單身驗證");
    expect(v.choice).toBe("either");
  });
  it("人臉過、單身審核中＝等審核", () => {
    const v = eligibilityView({ status: "single_reviewing", face_passed: true, single_status: "reviewing" }, 300);
    expect(v.choice).toBe("waitReview");
    expect(v.message).toContain("24 小時");
  });
  it("沒有帳號、退件", () => {
    expect(eligibilityView({ status: "no_account" }, 150).message).toContain("省 NT$150");
    expect(eligibilityView({ status: "single_rejected" }, 300).choice).toBe("payBase");
  });
});

describe("表單檢查", () => {
  it("完整表單沒有錯誤", () => {
    expect(validateForm(FORM, SESSION)).toEqual([]);
  });
  it("缺欄位", () => {
    const errs = validateForm({ ...FORM, interests: ["a", "", ""], single_declared: false, phone: "0212345678", name: "一二三四五六七八九十一" }, SESSION);
    expect(errs).toContain("請填寫 3 個興趣關鍵字");
    expect(errs).toContain("請勾選單身聲明");
    expect(errs).toContain("手機請填 09 開頭共 10 碼");
    expect(errs).toContain("暱稱最多 10 個字");
  });
  it("候補只要五欄", () => {
    expect(validateWaitlist({ name: "a", gender: "male", birth_date: "1970-01-01", phone: "0912345678", email: "a@b.co" }, SESSION)).toEqual([]);
  });
  it("手機格式", () => {
    expect(isValidPhone("0912-345-678")).toBe(true);
    expect(isValidPhone("912345678")).toBe(false);
  });
});

describe("payload", () => {
  it("報名不帶手機、帶 checkout_token／utm", () => {
    const p = buildRegistrationPayload({ ...FORM, interests: [" 爬山 ", "咖啡", "日本旅行"] }, { sessionId: 9, checkoutToken: "ct", txnToken: "tx", utm: { utm_source: "line_oa" } });
    expect(p.phone).toBeUndefined();
    expect(p).toMatchObject({ session_id: 9, checkout_token: "ct", txn_token: "tx", birth_date: "1970-05-01", utm: { utm_source: "line_oa" } });
    expect(p.interests).toEqual(["爬山", "咖啡", "日本旅行"]);
  });
  it("候補 payload", () => {
    const p = buildWaitlistPayload(FORM, { sessionId: 9, checkoutToken: "ct", utm: {} });
    expect(p).toMatchObject({ session_id: 9, nickname: "小橘", gender: "male" });
    expect(p.phone).toBeUndefined();
  });
});

describe("其他", () => {
  it("parseUtm 只留 utm_*", () => {
    expect(parseUtm("?utm_source=smile_group&utm_medium=fb_post&x=1")).toEqual({ utm_source: "smile_group", utm_medium: "fb_post" });
  });
  it("名額", () => {
    expect(genderOpen(SESSION, "male")).toBe(false);
    expect(genderOpen(SESSION, "female")).toBe(true);
    expect(remainingText(SESSION)).toBe("男生剩餘 0 名｜女生剩餘 12 名");
  });
});

import { contentHtml, heroPromoLines, mdw } from "../src/party-registration.js";

describe("頁面內容", () => {
  const S = { ...SESSION, start_time: "14:00:00", end_time: "17:00:00", location_name: "古月新城", location_address: "桃園市中壢區健行路 41 號", max_male: 20, max_female: 20, registration_end_at: "2026-12-11T15:59:59Z" };
  it("mdw 用台北時間", () => {
    expect(mdw("2026-12-06T15:59:59Z")).toBe("12/6（日）");
  });
  it("hero 文案依日期切換", () => {
    expect(heroPromoLines(S, new Date("2026-12-01T00:00:00Z"))[0]).toBe("12/6 前完成 App 人臉與單身驗證，男生省 NT$500、女生省 NT$400");
    const ext = heroPromoLines(S, new Date("2026-12-08T00:00:00Z"));
    expect(ext[0]).toBe("完成 App 驗證，男生省 NT$300；女生早鳥價延長到 12/11，省 NT$400");
    expect(ext.at(-1)).toBe("總報名未滿 20 人將取消活動並全額退費");
    const after = heroPromoLines({ ...S, female_early_extended: false }, new Date("2026-12-08T00:00:00Z"));
    expect(after[0]).toBe("完成 App 驗證，男生省 NT$300、女生省 NT$200");
  });
  it("內容含價格表、地點、退費規則、表單掛點，且不用破折號", () => {
    const html = contentHtml(S, { appLink: "https://x" });
    for (const t of ["NT$1,280", "NT$580", "NT$780", "健行路 41 號", "退 90%", 'id="od-party"', "2026/12/13（日）14:00–17:00", "12/11 報名截止",
      "13:45 開放報到", "NT$100–300", "報名男生省 NT$500、女生省 NT$400", "12/7 起男生省 NT$300、女生省 NT$200", "建議 12/5 前送出"]) {
      expect(html).toContain(t);
    }
    expect(html).not.toContain("—");
    expect(html).not.toContain("300–500");
    expect(html).not.toContain("13:30");
    expect(html).not.toMatch(/孤單|寂寞|大齡/);
  });
});
