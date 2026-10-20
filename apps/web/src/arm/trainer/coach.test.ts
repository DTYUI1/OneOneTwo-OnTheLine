import { describe, expect, it } from "vitest";
import {
  coachAnchor,
  coachGesture,
  coachKind,
  coachParts,
  coachPose,
  mentorAim,
  mentorOnRight,
  placeCoach,
  type Box,
} from "./coach";
import { poseToward } from "../../shared/mascot/mascotModel";
import { isLearning, type CardMode } from "./stages";

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

describe("обучение или тест (решение 17.10)", () => {
  it("учат только «Смотрю», «Вместе» и показ опытного", () => {
    expect(isLearning("watch")).toBe(true);
    expect(isLearning("together")).toBe(true);
    expect(isLearning("expert")).toBe(true);
    expect(isLearning("solo")).toBe(false);
    // Занятие преподавателя и каталог: режима нет.
    expect(isLearning(null)).toBe(false);
  });

  it("на тестах подсказки нет совсем", () => {
    const tests: { practice: boolean; mode: CardMode | null }[] = [
      { practice: true, mode: "solo" }, // «Сам», ступени 2–4, каталог сценариев
      { practice: false, mode: null }, // занятие преподавателя
      { practice: false, mode: "together" }, // режим из браузера не делает занятие учебным
    ];
    for (const item of tests) {
      const kind = coachKind({ ...item, closed: false, demo: false });
      expect(kind).toBeNull();
      expect(Object.values(coachParts(kind)).some(Boolean)).toBe(false);
    }
    // Даже показ, если он вдруг идёт по тестовой карточке.
    expect(
      coachKind({ practice: true, mode: "solo", closed: false, demo: true }),
    ).toBeNull();
  });

  it("«Смотрю» — фраза курсора, «Беру управление», памятка; без строк обучаемого", () => {
    const kind = coachKind({
      practice: true,
      mode: "watch",
      closed: false,
      demo: true,
    });
    expect(kind).toBe("watch");
    expect(coachParts(kind)).toEqual({
      say: true,
      controls: true,
      show: false,
      check: true,
      heard: false,
      urgency: false,
      clarity: false,
    });
  });

  it("«Вместе» — шаг, «Покажи», «Услышано», срочность и понятность комментария", () => {
    const kind = coachKind({
      practice: true,
      mode: "together",
      closed: false,
      demo: false,
    });
    expect(kind).toBe("together");
    expect(coachParts(kind)).toEqual({
      say: true,
      controls: false,
      show: true,
      check: true,
      heard: true,
      urgency: true,
      clarity: true,
    });
  });

  it("карточка «Вместе» закрыта или показ кончился — подсказка уходит", () => {
    expect(
      coachKind({
        practice: true,
        mode: "together",
        closed: true,
        demo: false,
      }),
    ).toBeNull();
    expect(
      coachKind({ practice: true, mode: "watch", closed: true, demo: false }),
    ).toBeNull();
  });
});

describe("к чему встаёт подсказка", () => {
  const none = { check: false, heard: false, clarity: false };
  it("«Вместе» — у элемента шага, «Смотрю» — у курсора", () => {
    expect(coachAnchor("together", none)).toBe("step");
    expect(coachAnchor("watch", none)).toBe("cursor");
  });
  it("проверка, «Услышано» и понятность — у строки статуса", () => {
    expect(coachAnchor("together", { ...none, heard: true })).toBe("line");
    expect(coachAnchor("together", { ...none, clarity: true })).toBe("line");
    expect(coachAnchor("together", { ...none, check: true })).toBe("line");
    expect(coachAnchor("watch", { ...none, check: true })).toBe("line");
  });
});

describe("placeCoach — не закрывает цель и окно телефона", () => {
  const view = { width: 1280, height: 720 };
  const size = { width: 340, height: 160 };
  const at = (place: { left: number; top: number }): Box => ({
    ...place,
    ...size,
  });

  it("над целью, если сверху есть место; хвостик — на цель", () => {
    const target = { left: 400, top: 500, width: 120, height: 30 };
    const place = placeCoach(target, size, view);
    expect(place.side).toBe("above");
    expect(overlaps(at(place), target)).toBe(false);
    expect(place.left + place.arrow).toBeCloseTo(460);
  });

  it("у верхнего края — под целью", () => {
    const target = { left: 400, top: 40, width: 120, height: 30 };
    const place = placeCoach(target, size, view);
    expect(place.side).toBe("below");
    expect(place.top).toBeGreaterThanOrEqual(70);
  });

  it("окно телефона рядом — подсказка его обходит", () => {
    const phone = { left: 760, top: 200, width: 460, height: 480 };
    const target = { left: 700, top: 440, width: 60, height: 28 };
    const place = placeCoach(target, size, view, [phone]);
    expect(overlaps(at(place), phone)).toBe(false);
    expect(overlaps(at(place), target)).toBe(false);
  });

  it("цель внутри окна телефона — подсказка у его края, хвостик на цель", () => {
    const phone = { left: 760, top: 200, width: 460, height: 480 };
    const target = { left: 800, top: 400, width: 120, height: 28 };
    const place = placeCoach(target, size, view, [phone]);
    expect(overlaps(at(place), phone)).toBe(false);
    expect(place.side).toBe("left");
    expect(place.left + size.width).toBeLessThanOrEqual(phone.left);
    expect(place.top + place.arrow).toBeCloseTo(414);
  });

  it("строка статуса — препятствие: подсказка над ней и её заметками, у ✓", () => {
    const line = { left: 60, top: 560, width: 1050, height: 70 };
    const confirm = { left: 1020, top: 594, width: 28, height: 28 };
    const place = placeCoach(confirm, size, view, [line]);
    expect(place.side).toBe("above");
    expect(place.top + size.height).toBeLessThanOrEqual(line.top);
    expect(place.left + size.width).toBeLessThanOrEqual(view.width);
  });

  // Проверка капитана 19.10, 1280×720: разговор с бригадой, цель — «По частям» внизу окна
  // телефона, под окном — строка статуса. Раньше подсказка вставала на окно телефона.
  const phone1280 = { left: 665, top: 140, width: 600, height: 440 };
  const line1280 = { left: 52, top: 593, width: 740, height: 36 };
  const mentorSize = { width: 480, height: 150 };

  it("цель внизу окна телефона — сбоку от окна, ближе к цели, а не у верхнего края", () => {
    const parts = { left: 860, top: 520, width: 110, height: 30 };
    const place = placeCoach(parts, mentorSize, view, [phone1280, line1280]);
    const box = { ...place, ...mentorSize };
    expect(place.side).toBe("left");
    expect(overlaps(box, phone1280)).toBe(false);
    expect(overlaps(box, line1280)).toBe(false);
    // Над строкой статуса, а не у верхнего края экрана: хвостик достаёт до цели.
    expect(place.top).toBe(line1280.top - mentorSize.height - 12);
    expect(place.top + place.arrow).toBeGreaterThan(parts.top);
  });

  it("места нет — подсказка закрывает строку статуса, но не окно телефона", () => {
    // Значок телефона на панели у правого края: вокруг него места без препятствий нет.
    const dial = { left: 1140, top: 668, width: 40, height: 40 };
    const place = placeCoach(dial, mentorSize, view, [phone1280, line1280]);
    const box = { ...place, ...mentorSize };
    expect(overlaps(box, dial)).toBe(false);
    expect(overlaps(box, phone1280)).toBe(false);
  });

  it("у правого края — внутри экрана", () => {
    const target = { left: 1240, top: 400, width: 30, height: 30 };
    const place = placeCoach(target, size, view);
    expect(place.left + size.width).toBeLessThanOrEqual(view.width);
    expect(overlaps(at(place), target)).toBe(false);
  });
});

describe("наставник в подсказке (библия маскота, раздел 5)", () => {
  const calm = {
    check: false,
    urgent: false,
    correcting: false,
    talking: false,
    paused: false,
  };

  it("указывает рукой по настоящему направлению к цели", () => {
    expect(coachGesture(calm)).toBe("point");
    expect(coachPose("point", "point-down")).toBe("point-down");
    expect(poseToward(300, 10)).toBe("point-right");
    expect(poseToward(-300, -10)).toBe("point-left");
    expect(poseToward(-100, 120)).toBe("point-down");
    expect(poseToward(-100, -120)).toBe("point-up");
    expect(poseToward(100, -120)).toBe("point-up-right");
  });

  it("направление — от плеча наставника к центру цели", () => {
    // Подсказка 450×190 слева от значка телефона, наставник у правого края.
    const place = { left: 122, top: 52 };
    const size = { width: 450, height: 190 };
    const phone = { left: 700, top: 355, width: 46, height: 46 };
    const aim = mentorAim(place, size, phone, true);
    // Плечо: x = 122 + 450 − 75, y = 52 + 52 — фигура у верхнего края.
    expect(aim).toEqual({ dx: 723 - 497, dy: 378 - 104 });
    // Слева — от плеча у левого края.
    expect(mentorAim(place, size, phone, false).dx).toBe(723 - 197);
    // Снимок капитана 18.10: подсказка слева от значка телефона, значок ниже — рука вниз
    // и вправо, а не строго вправо.
    expect(poseToward(aim.dx, aim.dy)).toBe("point-down-right");
  });

  it("проверка, норматив, поправка, разговор и пауза — свой жест, по важности", () => {
    expect(coachGesture({ ...calm, check: true, urgent: true })).toBe(
      "explain",
    );
    expect(coachGesture({ ...calm, urgent: true, talking: true })).toBe(
      "attention",
    );
    expect(coachGesture({ ...calm, correcting: true, talking: true })).toBe(
      "correct",
    );
    expect(coachGesture({ ...calm, talking: true })).toBe("listen");
    expect(coachGesture({ ...calm, paused: true })).toBe("wait");
    // Не указывает — поза не зависит от того, где цель.
    expect(coachPose("explain", "point-right")).toBe("explain");
    expect(coachPose("attention", "point-down")).toBe("attention");
  });

  it("стоит у края, ближнего к цели: сбоку — к цели, над и под — у хвостика", () => {
    expect(mentorOnRight({ side: "left", arrow: 16 }, 450)).toBe(true);
    expect(mentorOnRight({ side: "right", arrow: 400 }, 450)).toBe(false);
    expect(mentorOnRight({ side: "above", arrow: 32 }, 450)).toBe(false);
    expect(mentorOnRight({ side: "below", arrow: 32 }, 450)).toBe(false);
    // Значок телефона у правого края экрана — хвостик справа, наставник тоже.
    expect(mentorOnRight({ side: "above", arrow: 330 }, 450)).toBe(true);
  });
});
