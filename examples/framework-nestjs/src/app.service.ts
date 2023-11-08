import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
    helloWorld() {
        console.log(`Hello World. This method is called from inggest function`);
    }
}
