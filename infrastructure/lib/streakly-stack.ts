import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import { StreaklyObservability } from "./observability";

export interface StreaklyStackProps extends cdk.StackProps {
  stage: string;
}

export class StreaklyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StreaklyStackProps) {
    super(scope, id, props);
    const isProd = props.stage === "prod";
    const removal = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Optional: ARN of an SNS platform application (FCM credentials) created in the AWS console.
    //   cdk deploy -c platformApplicationArn=arn:aws:sns:REGION:ACCOUNT:app/GCM/streakly
    // Without it the API still works; devices are stored but push is disabled.
    const platformAppArn: string | undefined = this.node.tryGetContext("platformApplicationArn");
    const allowedOrigin: string = this.node.tryGetContext("allowedOrigin") ?? "*";
    const alertEmail: string | undefined = this.node.tryGetContext("alertEmail");

    cdk.Tags.of(this).add("Project", "Streakly");
    cdk.Tags.of(this).add("Stage", props.stage);
    cdk.Tags.of(this).add("ManagedBy", "AWS-CDK");

    // ---- Identity ----
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 8, requireDigits: true, requireLowercase: true },
      removalPolicy: removal,
    });
    const userPoolClient = userPool.addClient("MobileClient", {
      authFlows: { userSrp: true },
      generateSecret: false, // public mobile client
    });

    // ---- Data ----
    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      stream: dynamodb.StreamViewType.NEW_IMAGE, // badges / challenge progress consumer
      removalPolicy: removal,
    });
    // Reminder sweep: users keyed by their chosen local reminder slot (REMIND#HH:mm).
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    // Private learning-material bucket (used by the RAG phase).
    const filesBucket = new s3.Bucket(this, "LearningFiles", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: [allowedOrigin],
          allowedHeaders: ["*"],
        },
      ],
      removalPolicy: removal,
      autoDeleteObjects: !isProd,
    });

    // --- Phase 2: AI Plan Queues ---
    const aiPlanDlq = new sqs.Queue(this, "AiPlanDlq", {
      enforceSSL: true,
    });

    const aiPlanQueue = new sqs.Queue(this, "AiPlanQueue", {
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(300), // وقت طويل عشان الـ AI بياخد وقت
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: aiPlanDlq,
      },
    });

    // --- Phase 2: Push Notifications Retry Queues ---
    const pushRetryDlq = new sqs.Queue(this, "PushRetryDlq", {
      enforceSSL: true,
    });

    const pushRetryQueue = new sqs.Queue(this, "PushRetryQueue", {
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: pushRetryDlq,
      },
    });

    // ---- Compute ----
    const backendRoot = path.join(__dirname, "..", "..", "backend");
    const fn = (name: string, entry: string, exportName: string, extra: Partial<lambda.FunctionOptions> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(backendRoot, entry),
        handler: exportName,
        runtime: lambda.Runtime.NODEJS_24_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        tracing: lambda.Tracing.ACTIVE,
        environment: { TABLE_NAME: table.tableName, PLATFORM_APP_ARN: platformAppArn ?? "" },
        projectRoot: backendRoot,
        depsLockFilePath: path.join(backendRoot, "package-lock.json"),
        bundling: { minify: true, sourceMap: true },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: removal,
        }),
        ...extra,
      });

    const profileGet = fn("ProfileGet", "functions/profile/handler.ts", "get");
    const profilePut = fn("ProfilePut", "functions/profile/handler.ts", "put");
    const goalsCreate = fn("GoalsCreate", "functions/goals/handler.ts", "create");
    const goalsList = fn("GoalsList", "functions/goals/handler.ts", "list");
    const goalsGet = fn("GoalsGet", "functions/goals/handler.ts", "get");
    const tasksCreate = fn("TasksCreate", "functions/tasks/handler.ts", "create");
    const tasksComplete = fn("TasksComplete", "functions/tasks/handler.ts", "complete");
    const readToday = fn("ReadToday", "functions/read/handler.ts", "today");
    const readStreak = fn("ReadStreak", "functions/read/handler.ts", "streak");
    const readXp = fn("ReadXp", "functions/read/handler.ts", "xp");
    const readBadges = fn("ReadBadges", "functions/read/handler.ts", "badges");
    const challengesCreate = fn("ChallengesCreate", "functions/challenges/handler.ts", "create");
    const challengesJoin = fn("ChallengesJoin", "functions/challenges/handler.ts", "join");
    const challengesList = fn("ChallengesList", "functions/challenges/handler.ts", "list");
    const devicesRegister = fn("DevicesRegister", "functions/devices/handler.ts", "register");
    const devicesUnregister = fn("DevicesUnregister", "functions/devices/handler.ts", "unregister");
    const streamConsumer = fn("StreamConsumer", "functions/stream/handler.ts", "handler", {
      timeout: cdk.Duration.seconds(30),
    });
    const reminders = fn("Reminders", "functions/reminders/handler.ts", "handler", {
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    // Least privilege per function.
    table.grantReadWriteData(profilePut);
    table.grantReadData(profileGet);
    table.grantWriteData(goalsCreate);
    table.grantReadData(goalsList);
    table.grantReadData(goalsGet);
    table.grantReadWriteData(tasksCreate);
    table.grantReadWriteData(tasksComplete);
    [readToday, readStreak, readXp, readBadges].forEach((f) => table.grantReadData(f));
    [challengesCreate, challengesJoin].forEach((f) => table.grantReadWriteData(f));
    table.grantReadData(challengesList);
    [devicesRegister, devicesUnregister].forEach((f) => table.grantReadWriteData(f));
    table.grantReadWriteData(streamConsumer);
    table.grantReadWriteData(reminders); // reads GSI1 + goals/tasks, writes lastReminderDate / device state
    reminders.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${table.tableArn}/index/GSI1`] })
    );

    // SNS: register/refresh/delete endpoints and publish reminders (only when push is configured).
    if (platformAppArn) {
      const endpointArns = platformAppArn.replace(":app/", ":endpoint/") + "/*";
      devicesRegister.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["sns:CreatePlatformEndpoint"],
          resources: [platformAppArn],
        })
      );
      devicesRegister.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["sns:GetEndpointAttributes", "sns:SetEndpointAttributes"],
          resources: [endpointArns],
        })
      );
      devicesUnregister.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["sns:DeleteEndpoint"], resources: [endpointArns] })
      );
      reminders.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["sns:Publish"], resources: [endpointArns] })
      );
    }

    // ---- Streams: badges + challenge progress ----
    const streamDlq = new sqs.Queue(this, "StreamDlq", {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: removal,
    });
    streamConsumer.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        bisectBatchOnError: true,
        retryAttempts: 5,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(streamDlq),
        // Only new Completion items reach the Lambda; everything else is dropped before invocation.
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
            dynamodb: { NewImage: { entity: { S: lambda.FilterRule.isEqual("Completion") } } },
          }),
        ],
      })
    );

    // ---- Reminder schedule: every 15 minutes ----
    new events.Rule(this, "ReminderSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(reminders, { retryAttempts: 1 })],
    });

    // ---- API ----
    const api = new apigw.HttpApi(this, "Api", {
      apiName: `streakly-${props.stage}`,
      corsPreflight: {
        allowOrigins: [allowedOrigin],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["authorization", "content-type"],
      },
    });
    const authorizer = new HttpUserPoolAuthorizer("CognitoAuth", userPool, {
      userPoolClients: [userPoolClient],
    });
    const route = (p: string, m: apigw.HttpMethod, f: lambda.IFunction) =>
      api.addRoutes({
        path: p,
        methods: [m],
        integration: new HttpLambdaIntegration(`${m}${p}`.replace(/\W/g, ""), f),
        authorizer,
      });
    const { GET, POST, PUT, DELETE } = apigw.HttpMethod;

    route("/me", GET, profileGet);
    route("/me", PUT, profilePut);
    route("/goals", POST, goalsCreate);
    route("/goals", GET, goalsList);
    route("/goals/{goalId}", GET, goalsGet);
    route("/goals/{goalId}/tasks", POST, tasksCreate);
    route("/tasks/today", GET, readToday);
    route("/tasks/{taskId}/complete", POST, tasksComplete);
    route("/streak", GET, readStreak);
    route("/xp", GET, readXp);
    route("/badges", GET, readBadges);
    route("/challenges", POST, challengesCreate);
    route("/challenges", GET, challengesList);
    route("/challenges/{challengeId}/join", POST, challengesJoin);
    route("/devices/{deviceId}", PUT, devicesRegister);
    route("/devices/{deviceId}", DELETE, devicesUnregister);

    // Throttle to produce 429s instead of unbounded cost, and enable access logging.
    const defaultStage = api.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 25 };
      const apiAccessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: removal,
      });
      defaultStage.accessLogSettings = {
        destinationArn: apiAccessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          ip: "$context.identity.sourceIp",
          method: "$context.httpMethod",
          path: "$context.path",
          status: "$context.status",
          latency: "$context.responseLatency",
          error: "$context.error.message",
        }),
      };
    }

    // ---- Observability ----
    const completeErrorsAlarm = new cw.Alarm(this, "CompleteErrors", {
      metric: tasksComplete.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      alarmDescription: "Task completion Lambda is erroring",
    });
    const streamDlqAlarm = new cw.Alarm(this, "StreamDlqNotEmpty", {
      metric: streamDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Badge / challenge records failed repeatedly and landed in the DLQ",
    });
    const reminderErrorsAlarm = new cw.Alarm(this, "ReminderErrors", {
      metric: reminders.metricErrors({ period: cdk.Duration.minutes(15) }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: "Reminder sweep is failing",
    });

    new StreaklyObservability(this, "Observability", {
      stage: props.stage,
      api,
      table,
      streamDlq,
      functions: [
        profileGet,
        profilePut,
        goalsCreate,
        goalsList,
        goalsGet,
        tasksCreate,
        tasksComplete,
        readToday,
        readStreak,
        readXp,
        readBadges,
        challengesCreate,
        challengesJoin,
        challengesList,
        devicesRegister,
        devicesUnregister,
        streamConsumer,
        reminders,
      ],
      alarms: [completeErrorsAlarm, streamDlqAlarm, reminderErrorsAlarm],
      alertEmail,
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "FilesBucket", { value: filesBucket.bucketName });
    new cdk.CfnOutput(this, "PushConfigured", { value: platformAppArn ? "yes" : "no" });
  }
}