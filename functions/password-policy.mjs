export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 15;
export const PASSWORD_LENGTH_LABEL = `${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자`;
export const PASSWORD_LENGTH_ERROR = `비밀번호는 ${PASSWORD_LENGTH_LABEL}로 입력해 주세요.`;

export function isValidNewPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}
