using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Web.Http;
using System.Web.Http.Description;
using NLog;
using Weavy.Areas.Apps.Models;
using Weavy.Core;
using Weavy.Core.Localization;
using Weavy.Core.Models;
using Weavy.Core.Services;
using Weavy.Core.Utils;
using Weavy.Web.Api.Controllers;
using Weavy.Web.Api.Models;
using Weavy.Web.Models;

namespace Weavy.Areas.Api.Controllers
{
    /// <summary>
    /// Api controller for manipulating the Support Chat.
    /// </summary>
    [RoutePrefix("api")]
    public class SupportChatController : WeavyApiController
    {
        private static readonly Logger _log = LogManager.GetCurrentClassLogger();

        /// <summary>
        /// Create new conversation between agent and customer and return convo.
        /// </summary>
        /// <param name="model"></param>
        /// <returns></returns>
        [HttpPost]
        [ResponseType(typeof(Conversation))]
        [Route("support-chat")]
        public IHttpActionResult InsertSupportConversation(SupportChatIn model)
        {
            var users = new List<int>() { WeavyContext.Current.User.Id};
            var new_convo = new Conversation() { Name = model.Name };

            var role = RoleService.Get("Agent");
            if(role == null)
            {
                ThrowResponseException(HttpStatusCode.NotFound, "Role 'Agent' not found.");
            }
            var agents = RoleService.GetMembers(role.Id, new UserQuery() { Active = true});
            User agent;
            int agentTickets;

            if (agents.Count() == 0)
            {
                new_convo["ticket_type"] = "unclaimed";
                var convo = ConversationService.Insert(new_convo, users);
                var msg = new Message() { CreatedById = -2, Text = "No agents available at the moment. Please wait and one will help you shortly"};
                MessageService.Insert(msg, convo, sudo:true);
                return Ok(convo);
            }
            else
            {
                agent = agents.First();
                if (!int.TryParse((string)agent.Profile["openTickets"], out agentTickets))
                {
                    agent.Profile["open_tickets"] = "0";
                    UserService.Update(agent, true);
                    agentTickets = 0;
                }
            }
            foreach (var user in agents)
            {

                if (!int.TryParse((string)user.Profile["openTickets"], out var userTickets))
                {
                    user.Profile["open_tickets"] = "0";
                    UserService.Update(user, true);
                    userTickets = 0;
                }
                if (userTickets < agentTickets)
                {
                    agent = user;
                }
            }
            agent.Profile["openTickets"] = (agentTickets + 1).ToString();
            UserService.Update(agent, true);
            users.Add(agent.Id);
            var inserted = ConversationService.Insert(new_convo, users);
            var intro = new Message() { CreatedById = -2, Text = $"{agent.GetTitle()} is here to help you with your issue" };
            MessageService.Insert(intro, inserted, sudo: true);
            return Ok(inserted);
        }
    }
}
