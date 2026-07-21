import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { APP_OPTIONS, configureApp } from "./app-setup.js";
import { AppModule } from "./app.module.js";

const DEFAULT_PORT = 3000;

const port = Number(process.env.PORT ?? DEFAULT_PORT);

const app = await NestFactory.create<NestExpressApplication>(
  AppModule,
  APP_OPTIONS
);
configureApp(app);

// 0.0.0.0 rather than the default localhost: inside a Fly machine the loopback
// interface is not reachable from the proxy, so binding to it would deploy
// cleanly and then serve nobody.
await app.listen(port, "0.0.0.0");
