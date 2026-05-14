# Divo E2E Test Report — 2026-05-14T22:03:19.703Z

**Results:** 18/18 passed, 0 failed, 0 errors
**Total time:** 755.5s

| # | Domain | Prompt | Status | Tools | Duration | Reply |
|---|--------|--------|--------|-------|----------|-------|
| 1 | lark-task | show me my open tasks | ✓ pass | agent_lark_ops | 52840ms | You have 15 open tasks:

1. **Work on consciousness**
2. **W |
| 2 | lark-task | create a task "Review Q3 budget report"  | ✓ pass | agent_lark_ops | 33792ms | Task "Review Q3 budget report" created with a due date of 20 |
| 3 | lark-task | list all my tasklists | ✓ pass | agent_lark_ops | 37171ms | No tasklists were found in your workspace. |
| 4 | lark-calendar | what's on my calendar today? | ✓ pass | agent_lark_ops | 23694ms | You have one event scheduled for today: **Q3 Planning Review |
| 5 | lark-calendar | schedule a 30 min meeting with Anish tom | ✓ pass | agent_context_agent, agent_lark_ops | 104207ms | I've scheduled the "Sprint Review" meeting with Anish Suman  |
| 6 | lark-messaging | send a DM to Anish saying "Hey, can you  | ✓ pass | agent_lark_ops | 31332ms | I've sent that DM to Anish Suman. |
| 7 | lark-contacts | who is Anish? find his details | ✓ pass | agent_context_agent | 33213ms | Anish Suman is a contact in Lark. His email address is anish |
| 8 | google-gmail | show me my recent emails | ✓ pass | agent_google_ops | 34358ms | Here are your 10 most recent emails:

| Sender | Subject | D |
| 9 | zoho-books | show me overdue invoices for this month | ✓ pass | agent_zoho_ops | 52365ms | Zoho Books is not connected to your account, so I cannot ret |
| 10 | zoho-books | what is our total outstanding receivable | ✓ pass | agent_zoho_ops | 71215ms | Zoho Books is not connected to your account, so I cannot ret |
| 11 | context-search | search for any documents about "AI Engin | ✓ pass | agent_context_agent | 33723ms | I found a document titled "Mr. Market — The Complete Build P |
| 12 | web-search | what is the latest news about LLM agents | ✓ pass | agent_context_agent | 28875ms | As of May 2026, the key developments in LLM agents include:
 |
| 13 | multi | check my calendar for today and list my  | ✓ pass | agent_lark_ops, agent_lark_ops | 24985ms | Today is May 15, 2026.

**Calendar:**
Your calendar is clear |
| 14 | hinglish | mujhe aaj ke pending tasks dikhao | ✓ pass | agent_lark_ops | 26650ms | Aaj ke liye sirf ek hi task pending hai: **Review Q3 budget  |
| 15 | chitchat | hey divo, how are you? | ✓ pass | - | 20353ms | I am functioning within normal parameters. How can I assist  |
| 16 | out-of-domain | write me a poem about the moon | ✓ pass | - | 19195ms | A silver coin in velvet deep,
Watching while the weary sleep |
| 17 | ambiguous | check it | ✓ pass | agent_context_agent | 57707ms | "Mr. Market" is a comprehensive build plan for an AI-powered |
| 18 | vague | do the thing we talked about yesterday | ✓ pass | manageTodos, manageTodos, manageTodos, agent_lark_ops, manageTodos, manageTodos, agent_google_ops, manageTodos | 69838ms | I have completed the tasks we discussed:

1.  **Task Created |

## Detailed Results

### task-01 — lark-task
**Prompt:** show me my open tasks
**Status:** pass (52840ms)
**Tools:** agent_lark_ops
**Reply:** You have 15 open tasks:

1. **Work on consciousness**
2. **Work on history refreshing** (2 tasks)
3. **Work on text duplication**
4. **Work on conscious product**
5. **Review April 2026 bills for Marc

### task-02 — lark-task
**Prompt:** create a task "Review Q3 budget report" with due date tomorrow
**Status:** pass (33792ms)
**Tools:** agent_lark_ops
**Reply:** Task "Review Q3 budget report" created with a due date of 2026-05-15.

### task-03 — lark-task
**Prompt:** list all my tasklists
**Status:** pass (37171ms)
**Tools:** agent_lark_ops
**Reply:** No tasklists were found in your workspace.

### cal-01 — lark-calendar
**Prompt:** what's on my calendar today?
**Status:** pass (23694ms)
**Tools:** agent_lark_ops
**Reply:** You have one event scheduled for today: **Q3 Planning Review** from 10:30 AM to 11:15 AM.

### cal-02 — lark-calendar
**Prompt:** schedule a 30 min meeting with Anish tomorrow at 3pm IST titled "Sprint Review"
**Status:** pass (104207ms)
**Tools:** agent_context_agent, agent_lark_ops
**Reply:** I've scheduled the "Sprint Review" meeting with Anish Suman for tomorrow, May 16, from 3:00 PM to 3:30 PM IST.

### msg-01 — lark-messaging
**Prompt:** send a DM to Anish saying "Hey, can you review the PR?"
**Status:** pass (31332ms)
**Tools:** agent_lark_ops
**Reply:** I've sent that DM to Anish Suman.

### contact-01 — lark-contacts
**Prompt:** who is Anish? find his details
**Status:** pass (33213ms)
**Tools:** agent_context_agent
**Reply:** Anish Suman is a contact in Lark. His email address is anishsuman2305@gmail.com. I did not find any records for him in the CRM.

### gmail-01 — google-gmail
**Prompt:** show me my recent emails
**Status:** pass (34358ms)
**Tools:** agent_google_ops
**Reply:** Here are your 10 most recent emails:

| Sender | Subject | Date |
| :--- | :--- | :--- |
| Abhishek Verma | [relicwavetechnologies/zoho-automation] Run failed: Deploy - main (e3e5dd4) | 2026-05-14 |
|

### zoho-01 — zoho-books
**Prompt:** show me overdue invoices for this month
**Status:** pass (52365ms)
**Tools:** agent_zoho_ops
**Reply:** Zoho Books is not connected to your account, so I cannot retrieve the overdue invoices. Please check your integration settings.

### zoho-02 — zoho-books
**Prompt:** what is our total outstanding receivable?
**Status:** pass (71215ms)
**Tools:** agent_zoho_ops
**Reply:** Zoho Books is not connected to your account, so I cannot retrieve the total outstanding receivables. Please check your integration settings.

### ctx-01 — context-search
**Prompt:** search for any documents about "AI Engineering"
**Status:** pass (33723ms)
**Tools:** agent_context_agent
**Reply:** I found a document titled "Mr. Market — The Complete Build Plan," which outlines an AI trading assistant for FinWin. It covers the tech stack, data scraping strategies, LLM integration, and compliance

### web-01 — web-search
**Prompt:** what is the latest news about LLM agents in 2026?
**Status:** pass (28875ms)
**Tools:** agent_context_agent
**Reply:** As of May 2026, the key developments in LLM agents include:

*   **Security & Coding Agents:** Increased focus on the security risks of coding agents that can autonomously review repositories, execute

### multi-01 — multi
**Prompt:** check my calendar for today and list my open tasks, give me a quick daily briefing
**Status:** pass (24985ms)
**Tools:** agent_lark_ops, agent_lark_ops
**Reply:** Today is May 15, 2026.

**Calendar:**
Your calendar is clear of formal meetings today, with only a few untitled test entries.

**Tasks:**
You have 16 open tasks. Your priority for today is:
*   **Revi

### hindi-01 — hinglish
**Prompt:** mujhe aaj ke pending tasks dikhao
**Status:** pass (26650ms)
**Tools:** agent_lark_ops
**Reply:** Aaj ke liye sirf ek hi task pending hai: **Review Q3 budget report**.

Baaki ke open tasks ye hain:
*   Work on consciousness
*   Work on history refreshing (2)
*   Work on text duplication
*   Work o

### chat-01 — chitchat
**Prompt:** hey divo, how are you?
**Status:** pass (20353ms)
**Tools:** none
**Reply:** I am functioning within normal parameters. How can I assist you?

### chat-02 — out-of-domain
**Prompt:** write me a poem about the moon
**Status:** pass (19195ms)
**Tools:** none
**Reply:** A silver coin in velvet deep,
Watching while the weary sleep.
A silent guide through tides and night,
Reflecting back the hidden light.

### edge-01 — ambiguous
**Prompt:** check it
**Status:** pass (57707ms)
**Tools:** agent_context_agent
**Reply:** "Mr. Market" is a comprehensive build plan for an AI-powered trading assistant designed for the FinWin app. Its core philosophy is to minimize costs by using free, scraped public data while investing 

### edge-02 — vague
**Prompt:** do the thing we talked about yesterday
**Status:** pass (69838ms)
**Tools:** manageTodos, manageTodos, manageTodos, agent_lark_ops, manageTodos, manageTodos, agent_google_ops, manageTodos
**Reply:** I have completed the tasks we discussed:

1.  **Task Created:** "Review Mr. Market Build Plan" has been added to Lark with a due date of May 16, 2026.
2.  **Email Drafted:** A draft email summarizing 
