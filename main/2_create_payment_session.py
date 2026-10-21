import os
import boto3
import uuid

from dotenv import load_dotenv
load_dotenv() 

dp = boto3.client("bedrock-agentcore", 
    region_name=os.getenv("AWS_REGION")
    )

session = dp.create_payment_session(
    paymentManagerArn=os.getenv("PAYMENT_MANAGER_ARN"),
    userId=os.getenv("PAYMENT_USER_ID"),
    expiryTimeInMinutes=180,
    limits={"maxSpendAmount": {"value": "5.00", "currency": "USD"}},
)
payment_session_id = session["paymentSession"]["paymentSessionId"]
print(f"Payment Session ID: {payment_session_id}")