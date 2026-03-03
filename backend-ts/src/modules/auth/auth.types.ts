export interface RegisterDto {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface UserResponse {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  is_email_verified: boolean;
}

export interface AuthResponse {
  token: string;
  user: UserResponse;
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface SessionBootstrapResponse {
  user: UserResponse;
  organization: {
    id: string;
    name: string;
  } | null;
  membership: {
    role_key: string;
    status: string;
  } | null;
  capabilities: {
    tools_allowed: string[];
    tools_blocked: Array<{ tool: string; reason: string }>;
  };
}

export interface SessionExchangeRequest {
  exchange_token: string;
}
