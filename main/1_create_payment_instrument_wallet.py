import os
import boto3
import uuid

from dotenv import load_dotenv
load_dotenv() 

dp = boto3.client("bedrock-agentcore", 
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY"),
    aws_secret_access_key=os.getenv("AWS_SECRET_KEY")
    )


END_USER_EMAIL=os.getenv("END_USER_EMAIL") 

instr = dp.create_payment_instrument(
    paymentManagerArn=os.getenv("PAYMENT_MANAGER_ARN") ,
    paymentConnectorId=os.getenv("CONNECTOR_ID") ,
    userId=os.getenv("PAYMENT_USER_ID"),
    paymentInstrumentType="EMBEDDED_CRYPTO_WALLET",
    paymentInstrumentDetails={
        "embeddedCryptoWallet": {
            "network": "ETHEREUM",  # ETHEREUM covers Base + Base Sepolia
            "linkedAccounts": [{"email": {"emailAddress": os.getenv("END_USER_EMAIL") }}],
        }
    },
    clientToken=str(uuid.uuid4()),
)
instrument = instr.get("paymentInstrument", instr)

payment_instrument_id = instrument["paymentInstrumentId"]
print(f"Payment Instrument ID: {payment_instrument_id}")

wallet_address = instrument["paymentInstrumentDetails"]["embeddedCryptoWallet"]["walletAddress"]
print(f"Wallet Address: {wallet_address}")