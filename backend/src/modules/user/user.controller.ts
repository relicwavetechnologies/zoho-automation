import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { createUserSchema } from './dto/create-user.dto';
import { loginUserSchema } from './dto/login-user.dto';
import { UserService, userService } from './user.service';

class UserController extends BaseController {
  constructor(private readonly service: UserService = userService) {
    super();
  }

  register = async (req: Request, res: Response) => {
    const validated = createUserSchema.parse(req.body);
    const user = await this.service.registerUser(validated);
    return res.json(ApiResponse.success(user, 'User registered'));
  };

  login = async (req: Request, res: Response) => {
    const validated = loginUserSchema.parse(req.body);
    const token = await this.service.loginUser(validated);
    return res.json(ApiResponse.success(token, 'Login successful'));
  };
}

export const userController = new UserController();


