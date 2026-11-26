---
schema_version: 1
id: m-idempotency
scope_id: "group:payments"
description: "가상 결제 요청의 재시도에는 같은 멱등 키를 재사용한다"
key: "payments.retry.idempotency"
aliases: ["멱등성", "idempotency", "retry key", "결제", "payment"]
tags: ["fictional", "payments", "retry"]
updated_at: "2026-11-25T00:00:00Z"
---
# 가상 결제 재시도 규칙

이 기억은 기능 확인용 가상 데이터다.

같은 결제 요청을 다시 보낼 때는 같은 멱등 키를 사용한다.
새로운 결제 요청에는 새로운 키를 발급한다.
키는 테스트에서 지정한 요청 단위로 유지한다.

가상의 근거: SAMPLE-PAYMENTS-01.
