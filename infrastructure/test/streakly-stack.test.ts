import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { StreaklyStack } from "../lib/streakly-stack";

describe("StreaklyStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        alertEmail: "devops@streakly.app",
      },
    });
    const stack = new StreaklyStack(app, "StreaklyTestStack", {
      stage: "dev",
    });
    template = Template.fromStack(stack);
  });

  test("creates DynamoDB single-table with GSI1 and Streams", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      StreamSpecification: {
        StreamViewType: "NEW_IMAGE",
      },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
        }),
      ]),
    });
  });

  test("creates private, encrypted S3 bucket with SSL enforced", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "AES256",
            },
          }),
        ]),
      },
    });
  });

  test("creates Cognito UserPool with password policy", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireNumbers: true,
          RequireLowercase: true,
        }),
      },
    });
  });

  test("creates all 18 Node.js 24 Lambda functions with X-Ray Active tracing", () => {
    const appFunctions = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Runtime: "nodejs24.x",
        TracingConfig: {
          Mode: "Active",
        },
      },
    });
    expect(Object.keys(appFunctions).length).toBeGreaterThanOrEqual(18);
  });

  test("creates HTTP API with Cognito JWT Authorizer", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
    });
  });

  // --- التعديل هنا: تحديث عدد الـ Queues لـ 5 ---
  test("creates SQS Queues (DLQs, AI, Retry) and 15-minute EventBridge schedule", () => {
    template.resourceCountIs("AWS::SQS::Queue", 5);
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(15 minutes)",
    });
  });

  test("creates CloudWatch Dashboard, 4 Alarms, and SNS email alerts", () => {
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "devops@streakly.app",
    });
  });
});