export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiResponse {
  static success<T>(data: T, message?: string): ApiSuccessResponse<T> {
    return {
      success: true,
      data,
      message,
    };
  }

  static error(message: string): ApiErrorResponse {
    return {
      success: false,
      message,
    };
  }
}

