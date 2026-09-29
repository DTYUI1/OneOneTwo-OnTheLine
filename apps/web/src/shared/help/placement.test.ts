import { expect, it } from "vitest";
import { MARKER_SIZE, placeMarkers, type Box } from "./placement";

const viewport = { width: 1600, height: 900 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;
const marker = (place: { left: number; top: number }) =>
  box(place.left, place.top, MARKER_SIZE, MARKER_SIZE);

it("ставит номер на левый верхний угол рамки, если там нет надписей", () => {
  const [place] = placeMarkers([box(300, 200, 400, 300)], [], viewport);
  expect(place).toEqual({
    left: 300 - MARKER_SIZE / 2,
    top: 200 - MARKER_SIZE / 2,
  });
});

it("не закрывает заголовок части, прижатый к углу", () => {
  const part = box(0, 124, 1600, 128);
  const heading = box(16, 140, 310, 36);
  const [place] = placeMarkers([part], [heading], viewport);
  expect(overlaps(marker(place), heading)).toBe(false);
  expect(place.top).toBeLessThan(part.top + part.height);
});

it("номер остаётся в окне у частей, прижатых к краю", () => {
  const [place] = placeMarkers([box(0, 0, 200, 100)], [], viewport);
  expect(place.left).toBeGreaterThanOrEqual(0);
  expect(place.top).toBeGreaterThanOrEqual(0);
});

it("номера соседних частей не накладываются друг на друга", () => {
  const places = placeMarkers(
    [box(100, 100, 300, 50), box(100, 100, 300, 50), box(102, 104, 300, 50)],
    [],
    viewport,
  );
  const boxes = places.map(marker);
  expect(overlaps(boxes[0], boxes[1])).toBe(false);
  expect(overlaps(boxes[0], boxes[2])).toBe(false);
  expect(overlaps(boxes[1], boxes[2])).toBe(false);
});

it("без свободного места номер остаётся внутри угла части", () => {
  const part = box(100, 100, 300, 50);
  const [place] = placeMarkers([part], [box(0, 0, 1600, 900)], viewport);
  expect(place).toEqual({ left: 102, top: 102 });
});
