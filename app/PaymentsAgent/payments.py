import os
from pathlib import Path

from dotenv import load_dotenv
from bedrock_agentcore.payments.integrations.config import AgentCorePaymentsPluginConfig
from bedrock_agentcore.payments.integrations.strands.plugin import AgentCorePaymentsPlugin

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def load_payments_plugin() -> AgentCorePaymentsPlugin:
    """Build the AgentCore Payments plugin from environment variables."""
    config = AgentCorePaymentsPluginConfig(
        payment_manager_arn=os.getenv("PAYMENT_MANAGER_ARN"),
        user_id=os.getenv("PAYMENT_USER_ID"),
        payment_instrument_id=os.getenv("PAYMENT_INSTRUMENT_ID"),
        payment_session_id=os.getenv("PAYMENT_SESSION_ID"),
        region=os.getenv("AWS_REGION"),
    )
    return AgentCorePaymentsPlugin(config=config)
