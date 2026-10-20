import { test, expect } from "@playwright/test";

// Проверяет лимит всего HTTP-запроса на прокси, а не только read_upload в API.
test("материал ровно 10 МиБ проходит через веб-сервер", async ({ request }) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужен стенд с демонстрационными учётками",
  );
  const login = await request.post("/api/auth/login", {
    data: {
      login: "teacher",
      password: process.env.DEMO_PASSWORD ?? "demo-local",
    },
  });
  expect(login.ok()).toBeTruthy();
  const state = await request.storageState();
  const csrf = state.cookies.find((cookie) => cookie.name === "csrf");
  expect(csrf).toBeDefined();
  const file = Buffer.alloc(10 * 1024 * 1024, " ");
  file.write("%PDF-1.4\n%%EOF\n");
  const send = (buffer: Buffer) =>
    request.post("/api/materials", {
      headers: { "X-CSRF-Token": csrf!.value },
      multipart: {
        file: { name: "limit.pdf", mimeType: "application/pdf", buffer },
        metadata: JSON.stringify({
          title: "Проверка границы размера материала",
          purpose: "reference",
          previous_id: null,
          previous_version: null,
        }),
      },
    });
  const accepted = await send(file);
  expect(accepted.status()).toBe(201);
  const material = await accepted.json();
  expect(material.size_bytes).toBe(file.length);
  const downloaded = await request.get(
    `/api/materials/${material.id}/content?version=1`,
  );
  expect(downloaded.status()).toBe(200);
  expect((await downloaded.body()).equals(file)).toBeTruthy();
  const rejected = await send(Buffer.concat([file, Buffer.from(" ")]));
  expect(rejected.status()).toBe(413);
  expect((await rejected.json()).message).toContain("10 МиБ");
});
