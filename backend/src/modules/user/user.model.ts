export interface User {
  id: string;
  email: string;
  name?: string | null;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}


