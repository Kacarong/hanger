export const MIN_PASSWORD_LENGTH = 12;

// Why a password may not be used, or null when it is fine. The old default ("kacarong") is in the
// public repo's history, so anything containing the site name is refused for login too.
export function passwordProblem(p: string): string | null {
  if (p.length < MIN_PASSWORD_LENGTH) return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`;
  if (p.toLowerCase().includes("kacarong")) return "사이트 이름(kacarong)이 들어간 비밀번호는 쓸 수 없습니다";
  return null;
}
