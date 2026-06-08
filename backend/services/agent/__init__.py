"""
EditFlow Agent — LLM-driven orchestrator package.

Replaces the rigid 7-stage frontend state machine with a tool-calling
agent loop.  The agent reads the user's input and conversation history,
then decides what to do by calling tools that are thin wrappers over
existing backend services.
"""
