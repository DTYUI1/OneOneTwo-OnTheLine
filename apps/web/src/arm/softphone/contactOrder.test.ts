import { describe, expect, it } from "vitest";
import { orderContacts } from "./contactOrder";

const contact = (id: string, ext: string) => ({ id, phone_ext: ext });
const catalog = [
  contact("gas", "104"),
  contact("fire", "101"),
  contact("ambulance", "103"),
  contact("police", "102"),
  contact("edds", "112"),
];
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe("orderContacts", () => {
  it("ставит свою службу первой, за ней службы карточки, потом прочие", () => {
    expect(
      ids(orderContacts(catalog, "police", ["ambulance", "police"])),
    ).toEqual(["police", "ambulance", "fire", "gas", "edds"]);
  });

  it("своя служба первая, даже если её нет в карточке", () => {
    expect(ids(orderContacts(catalog, "gas", ["ambulance"]))[0]).toBe("gas");
    expect(ids(orderContacts(catalog, "gas", ["ambulance"]))[1]).toBe(
      "ambulance",
    );
  });

  it("внутри группы порядок по номеру и не зависит от порядка каталога", () => {
    const reversed = [...catalog].reverse();
    const cardIds = ["gas", "fire", "ambulance"];
    expect(ids(orderContacts(reversed, "police", cardIds))).toEqual(
      ids(orderContacts(catalog, "police", cardIds)),
    );
    expect(ids(orderContacts(catalog, "police", cardIds))).toEqual([
      "police",
      "fire",
      "ambulance",
      "gas",
      "edds",
    ]);
  });

  it("без своей службы — прежний порядок: службы карточки, потом прочие", () => {
    const expected = ["fire", "gas", "police", "ambulance", "edds"];
    expect(ids(orderContacts(catalog, null, ["gas", "fire"]))).toEqual(
      expected,
    );
    expect(ids(orderContacts(catalog, undefined, ["gas", "fire"]))).toEqual(
      expected,
    );
  });

  it("не меняет исходный список", () => {
    const before = ids(catalog);
    orderContacts(catalog, "police", ["gas"]);
    expect(ids(catalog)).toEqual(before);
  });
});
