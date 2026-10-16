#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { WorkshopApiStack } from "../lib/api-stack";

const app = new cdk.App();

new WorkshopApiStack(app, "WorkshopApiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

// Run the AWS Solutions rule pack on every synth. Accepted findings are
// suppressed with a reason in lib/api-stack.ts.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, reports: true }));
