import { User } from '@prisma/client';

import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';
import { CreateUserDto } from './dto/create-user.dto';

export class UserRepository extends BaseRepository {
  createUser(data: CreateUserDto & { password: string }): Promise<User> {
    return prisma.user.create({ data });
  }

  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }
}

export const userRepository = new UserRepository();


