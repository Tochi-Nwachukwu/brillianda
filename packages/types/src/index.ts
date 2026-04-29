export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  TEACHER = 'TEACHER',
  STUDENT = 'STUDENT',
}

export enum ExamStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  CLOSED = 'CLOSED',
  ARCHIVED = 'ARCHIVED',
}

export enum QuestionType {
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
  message?: string;
}

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
  iat: number;
  exp: number;
}
