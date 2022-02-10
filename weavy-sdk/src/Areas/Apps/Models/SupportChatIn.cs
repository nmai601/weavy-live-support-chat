using System;
using System.Collections.Generic;
using System.Linq;
using System.Web;

namespace Weavy.Areas.Apps.Models
{
    /// <summary>
    ///  A model used for inserting conversation into Support Chat.
    /// </summary>
    public class SupportChatIn
    {
        /// <summary>
        /// Gets the name for the Conversation to add.
        /// </summary>
        public string Name { get; set; }
    }
}
