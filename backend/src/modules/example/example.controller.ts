import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { ExampleService, exampleService } from './example.service';
import { createExampleSchema } from './dto/create-example.dto';

class ExampleController extends BaseController {
  constructor(private readonly service: ExampleService = exampleService) {
    super();
  }

  createExample = async (req: Request, res: Response) => {
    const validated = createExampleSchema.parse(req.body);
    const example = await this.service.createExample(validated);
    return res.json(ApiResponse.success(example, 'Example created'));
  };

  getExamples = async (_req: Request, res: Response) => {
    const examples = await this.service.getExamples();
    return res.json(ApiResponse.success(examples, 'Examples retrieved'));
  };
}

export const exampleController = new ExampleController();


