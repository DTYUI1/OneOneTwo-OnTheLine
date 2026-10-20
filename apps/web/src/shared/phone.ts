/** +79161234567 → +7 (916) 123-45-67; иное — как есть. */
export function formatPhone(phone: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+7 (${match[1]}) ${match[2]}-${match[3]}-${match[4]}` : phone;
}
