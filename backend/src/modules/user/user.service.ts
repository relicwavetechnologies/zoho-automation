import jwt from 'jsonwebtoken';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { comparePassword, hashPassword } from '../../utils/bcrypt';
import { userRepository, UserRepository } from './user.repository';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { User } from './user.model';

export class UserService extends BaseService {
  constructor(private readonly repository: UserRepository = userRepository) {
    super();
  }

  async registerUser(payload: CreateUserDto): Promise<User> {
    const existing = await this.repository.findByEmail(payload.email);
    if (existing) {
      throw new HttpException(409, 'Email already in use');
    }

    const password = await hashPassword(payload.password);
    const user = await this.repository.createUser({ ...payload, password });
    return user;
  }

  async loginUser(payload: LoginUserDto): Promise<{ token: string }> {
    const user = await this.repository.findByEmail(payload.email);
    if (!user) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const isValid = await comparePassword(payload.password, user.password);
    if (!isValid) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const token = jwt.sign({ userId: user.id }, config.JWT_SECRET, { expiresIn: '1h' });
    return { token };
  }
}

export const userService = new UserService();


