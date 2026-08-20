#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();
program
  .name("ralph")
  .description("A deterministic AI coding loop orchestrator.");

program.parse();
