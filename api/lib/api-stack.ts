import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { NagSuppressions } from "cdk-nag";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable for deployment: ${name}`);
  }

  return value;
}

export class WorkshopApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mppEnabled = process.env.MPP_ENABLED === "true";

    const functionLogGroup = new logs.LogGroup(this, "ContentFunctionLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Execution role scoped to this function's own log group, instead of the
    // AWSLambdaBasicExecutionRole managed policy (which allows writing to any
    // log group in the account).
    const functionRole = new iam.Role(this, "ContentFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the workshop content function",
    });
    functionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [functionLogGroup.logGroupArn],
      }),
    );

    const contentFunction = new NodejsFunction(this, "ContentFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: mppEnabled
        ? process.env.MPP_HANDLER_ENTRY ?? "src/mpp-handler.solution.ts"
        : "src/handler.ts",
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      role: functionRole,
      logGroup: functionLogGroup,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: mppEnabled
        ? {
            CONTENT_VERSION: "x402-enabled",
            MPP_AMOUNT: process.env.MPP_AMOUNT ?? "0.01",
            MPP_REALM: process.env.MPP_REALM ?? "workshop-x402-api",
            MPP_SECRET_KEY: requiredEnv("MPP_SECRET_KEY"),
            STRIPE_LIVEMODE: process.env.STRIPE_LIVEMODE ?? "false",
            STRIPE_PROFILE_ID: requiredEnv("STRIPE_PROFILE_ID"),
            STRIPE_SECRET_KEY: requiredEnv("STRIPE_SECRET_KEY"),
            X402_FACILITATOR_URL: requiredEnv("X402_FACILITATOR_URL"),
          }
        : {
            CONTENT_VERSION: "starter",
          },
    });

    const accessLogGroup = new logs.LogGroup(this, "ApiAccessLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigatewayv2.HttpApi(this, "WorkshopHttpApi", {
      apiName: "workshop-mpp-starter-api",
      description: "Starter API for the AWS Lambda mppx/x402 workshop",
      createDefaultStage: false,
    });

    api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      // Rate limits keep a public endpoint from being used to run up cost.
      throttle: { rateLimit: 10, burstLimit: 20 },
      accessLogSettings: {
        // Format defaults to Common Log Format.
        destination: new apigatewayv2.LogGroupLogDestination(accessLogGroup),
      },
    });

    const contentRoute = api.addRoutes({
      path: "/content",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ContentIntegration", contentFunction),
    });

    NagSuppressions.addResourceSuppressions(contentRoute, [
      {
        id: "AwsSolutions-APIG4",
        reason:
          "GET /content is a public, pay-per-call endpoint. Access control is the " +
          "x402 payment itself: the function returns HTTP 402 until the caller " +
          "presents a valid signed payment. An authorizer would defeat the purpose " +
          "of the sample, which is an API that any agent can pay for without an account.",
      },
    ]);

    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.apiEndpoint,
      description: "Base URL for the workshop API. Call GET /content.",
    });
  }
}
