# Agent Note: Agent-bound IM discovery

Status: implemented

English | [中文](2026-09-12-im-agent-discovery.zh.md)

## Problem

An AI needs its own identity, contact addresses, and joined chats to choose a recipient without accessing another participant's private relationships.

## Decision

The IM binding registers `im_context` and `talk` on one Agent per AI identity. Contact relationships are mutual private messaging authorization, stored once; group membership independently permits group messages. Authorization interfaces edit contacts rather than a separate permission layer.

Each AI persists its selected group/contact page or no page. Only the selected page queues message contents before the next unstarted tool. Other conversations send coalesced sender/count notifications and retain unread content. Notifications can be ignored; opening a page queues its unread messages. Ordinary assistant text stays private and only `talk` publishes messages. Identity selection comes from the binding, never a model-supplied owner.

The [Agent scope decision](../architecture/2026-07-08-agent-scope-contexts.md) continues to own registration visibility and lifetime. The [WeCom conversation decision](2026-09-12-wecom-owned-conversations.md) owns independent external transport conversations. Neither decision is superseded.

## Alternatives considered

A global tool accepting an arbitrary participant ID permits private relationship discovery under the wrong identity. Copying contacts into the system prompt makes relationship changes stale and consumes context even when no discovery is needed.

## Consequences

Discovery returns current data through logged tool results and generic tool presentation. Tests cover two independent identities, excluded private chats, live contact removal, an unbound Agent, mutual contact revocation, group communication without contacts, page selection and departure, and model-visible logging. The package-owned output fixture pins the returned text; shipped-profile Session replay remains a coverage gap.
