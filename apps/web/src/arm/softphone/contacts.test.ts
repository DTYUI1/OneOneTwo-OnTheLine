import { describe, expect, it } from "vitest";
import {
  contactProblems,
  contactServices,
  contactsFor,
  CONTACTS_MAX,
  DEFAULT_CONTACTS,
  dialNumber,
  ownNumber,
  virtualPhone,
  type PhoneContact,
} from "./contacts";

const caller: PhoneContact = {
  role: "caller",
  name: "Заявитель",
  number: "450",
};

describe("абоненты телефона ДДС", () => {
  it("нет списка у ДДС — по умолчанию руководство и аварийная бригада, без заявителя", () => {
    expect(contactsFor(null, "GKH")).toBe(DEFAULT_CONTACTS);
    expect(contactsFor({ phone_contacts: { "101": [] } }, "GKH")).toBe(
      DEFAULT_CONTACTS,
    );
    expect(DEFAULT_CONTACTS.map((item) => item.number)).toEqual([
      "401",
      "402",
      "403",
      "404",
    ]);
    expect(DEFAULT_CONTACTS.some((item) => item.role === "caller")).toBe(false);
  });
  it("список преподавателя действует, пустой — абонентов нет", () => {
    expect(contactsFor({ phone_contacts: { GKH: [caller] } }, "GKH")).toEqual([
      caller,
    ]);
    expect(contactsFor({ phone_contacts: { GKH: [] } }, "GKH")).toEqual([]);
  });
  it("11-й абонент, повтор номера и номер службы не проходят", () => {
    const many = Array.from({ length: CONTACTS_MAX + 1 }, (_, index) => ({
      role: "head" as const,
      name: `Абонент ${index}`,
      number: String(410 + index),
    }));
    expect(contactProblems(many.slice(0, CONTACTS_MAX))).toEqual([]);
    expect(contactProblems(many)).toEqual([
      "Не больше 10 номеров на одну ДДС.",
    ]);
    expect(contactProblems([caller, { ...caller, role: "head" }])).toEqual([
      "Номера абонентов повторяются.",
    ]);
    expect(contactProblems([{ ...caller, number: "103" }])).toEqual([
      "Номер абонента — три цифры от 400 до 999.",
    ]);
  });
  it("заявителя набирают номером из карточки, только если он в списке", () => {
    const phones = ["+79001234567"];
    expect(dialNumber("+7 900 123-45-67", [caller], phones)).toBe("450");
    expect(dialNumber("89001234567", [caller], phones)).toBe("450");
    expect(dialNumber("+79001234567", DEFAULT_CONTACTS, phones)).toBeNull();
    expect(dialNumber("+79990000000", [caller], phones)).toBeNull();
    expect(dialNumber("401", [], phones)).toBe("401");
  });
  it("службу набирают и городским номером справочника", () => {
    const services = [
      { phone_ext: "104", phone: "+74950004904" },
      { phone_ext: "105", phone: null },
    ];
    expect(dialNumber("+7 (495) 000-49-04", [], [], services)).toBe("104");
    expect(dialNumber("84950004904", [], [], services)).toBe("104");
    expect(dialNumber("+74950000000", [], [], services)).toBeNull();
  });
  it("абонент звонится как служба своей ДДС, с её голосом", () => {
    const own = {
      id: "GKH",
      code: "GKH",
      name: "ЖКХ",
      category: "utilities",
      phone_ext: "105",
      voice_profile: "voice-1",
      is_active: true,
    };
    expect(contactServices(DEFAULT_CONTACTS.slice(0, 1), own)).toEqual([
      {
        ...own,
        name: "Руководитель организации",
        phone_ext: "401",
        phone: null,
      },
    ]);
    expect(contactServices(DEFAULT_CONTACTS, undefined)).toEqual([]);
  });
  it("у бригад и руководства — полный условный номер, по нему и звонят", () => {
    expect(virtualPhone("103", "205")).toBe("+74951030205");
    expect(virtualPhone("103", "401")).toBe("+74951030401");
    expect(dialNumber("+7 (495) 103-02-05", [], [], [], "103")).toBe("205");
    expect(dialNumber("84951030401", [], [], [], "103")).toBe("401");
    // Номер чужой ДДС и номер рабочего места — недоступны.
    expect(dialNumber("+7 (495) 101-04-01", [], [], [], "103")).toBeNull();
    expect(dialNumber("+7 (495) 103-00-03", [], [], [], "103")).toBeNull();
  });
  it("свой номер — полный условный своей службы с номером рабочего места", () => {
    const service = { phone_ext: "103", phone: "+74950003803" };
    expect(ownNumber(service, 3)).toBe("+7 (495) 103-00-03");
    expect(ownNumber(service, 23)).toBe("+7 (495) 103-00-23");
    expect(ownNumber(service, null)).toBe("+7 (495) 000-38-03");
    expect(ownNumber(undefined, 3)).toBeNull();
  });
});
