/**
 * 博客加载器 - 使用方法二：JSON管理 + 动态加载
 */
class BlogLoader {
  constructor() {
    this.container = document.getElementById("blog-posts-container");
    this.stats = document.getElementById("blog-stats");
    this.postsCount = document.getElementById("posts-count");
    this.totalPosts = document.getElementById("total-posts");
    this.searchInput = document.getElementById("blog-search");
    this.tagFilters = document.querySelectorAll(".tag-filter");

    this.allPosts = [];
    this.filteredPosts = [];
    this.currentTag = "all";
    this.searchTerm = "";

    this.init();
  }

  async init() {
    // 绑定事件
    this.bindEvents();

    // 加载博客文章
    await this.loadBlogPosts();

    // 显示统计信息
    this.updateStats();
  }

  bindEvents() {
    // 搜索功能
    if (this.searchInput) {
      this.searchInput.addEventListener("input", (e) => {
        this.searchTerm = e.target.value.toLowerCase();
        this.filterPosts();
      });
    }

    // 标签过滤
    this.tagFilters.forEach((button) => {
      button.addEventListener("click", () => {
        // 更新激活状态
        this.tagFilters.forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");

        // 过滤文章
        this.currentTag = button.dataset.tag;
        this.filterPosts();
      });
    });
  }

  async loadBlogPosts() {
    try {
      // 显示加载状态
      this.showLoading();

      // 加载博客清单
      const response = await fetch("blog/blog-manifest.json");
      const data = await response.json();

      // 保存所有文章信息
      this.allPosts = data.posts;

      // 加载每篇文章的内容
      await this.loadAllPostContents();

      // 显示文章
      this.displayPosts(this.allPosts);
    } catch (error) {
      console.error("Error loading blog posts:", error);
      this.showError();
    }
  }

  async loadAllPostContents() {
    // 并行加载所有文章内容
    const loadPromises = this.allPosts.map(async (post) => {
      try {
        const response = await fetch(`blog/posts/${post.filename}`);
        const html = await response.text();

        // 解析HTML获取内容摘要（前300个字符）
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        const contentElement = tempDiv.querySelector(".post-content");

        if (contentElement) {
          // 提取纯文本作为摘要
          let summary = contentElement.textContent.trim();
          post.summary =
            summary.length > 300 ? summary.substring(0, 300) + "..." : summary;
        }

        // 保存完整的HTML内容
        post.fullContent = html;
      } catch (error) {
        console.error(`Error loading post ${post.filename}:`, error);
        post.summary = "Content could not be loaded.";
        post.fullContent = `<p>Error loading content for: ${post.title}</p>`;
      }
    });

    await Promise.all(loadPromises);
  }

  displayPosts(posts) {
    // 清空容器
    this.container.innerHTML = "";

    if (posts.length === 0) {
      this.container.innerHTML = `
        <div class="no-results">
          <i class="far fa-file-alt"></i>
          <h3>No blog posts found</h3>
          <p>Try changing your search or filter criteria.</p>
        </div>
      `;
      return;
    }

    // 按日期排序（最新的在前）
    const sortedPosts = [...posts].sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    // 创建文章元素
    sortedPosts.forEach((post) => {
      const postElement = this.createPostElement(post);
      this.container.appendChild(postElement);
    });
  }

  createPostElement(post) {
    const article = document.createElement("article");
    article.className = "blog-post";
    article.dataset.id = post.id;
    article.dataset.tags = post.tags.join(",");

    // 创建标签HTML
    const tagsHTML = post.tags
      .map((tag) => `<span class="tag">${tag}</span>`)
      .join("");

    article.innerHTML = `
      <div class="post-header">
        <h3>${post.title}</h3>
        <div class="post-meta">
          <span><i class="far fa-calendar"></i>${post.date}</span>
          <span><i class="far fa-clock"></i>${post.readTime}</span>
        </div>
      </div>
      <div class="post-content-preview">
        <p>${post.summary || "Read more..."}</p>
      </div>
      <div class="post-footer">
        <div class="post-tags">
          ${tagsHTML}
        </div>
        <button class="read-more-btn" data-post-id="${post.id}">
          Read Full Article <i class="fas fa-arrow-right"></i>
        </button>
      </div>
      <div class="post-full-content" id="full-content-${post.id}" style="display: none;">
        <!-- 完整内容将通过JavaScript动态加载 -->
      </div>
    `;

    // 绑定"阅读更多"按钮事件
    const readMoreBtn = article.querySelector(".read-more-btn");
    readMoreBtn.addEventListener("click", () =>
      this.toggleFullContent(post.id),
    );

    return article;
  }

  async toggleFullContent(postId) {
    const fullContentDiv = document.getElementById(`full-content-${postId}`);
    const readMoreBtn = document.querySelector(
      `.read-more-btn[data-post-id="${postId}"]`,
    );

    if (fullContentDiv.style.display === "none") {
      // 显示完整内容
      const post = this.allPosts.find((p) => p.id === postId);

      if (post && !fullContentDiv.innerHTML.trim()) {
        // 如果尚未加载完整内容，则加载
        fullContentDiv.innerHTML = post.fullContent;
      }

      fullContentDiv.style.display = "block";
      readMoreBtn.innerHTML = 'Show Less <i class="fas fa-arrow-up"></i>';
      readMoreBtn.classList.add("active");

      // 滚动到文章顶部
      fullContentDiv.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // 隐藏完整内容
      fullContentDiv.style.display = "none";
      readMoreBtn.innerHTML =
        'Read Full Article <i class="fas fa-arrow-right"></i>';
      readMoreBtn.classList.remove("active");
    }
  }

  filterPosts() {
    this.filteredPosts = this.allPosts.filter((post) => {
      // 标签过滤
      const tagMatch =
        this.currentTag === "all" ||
        post.tags.some((tag) => tag.toLowerCase().includes(this.currentTag));

      // 搜索过滤
      const searchMatch =
        !this.searchTerm ||
        post.title.toLowerCase().includes(this.searchTerm) ||
        post.summary.toLowerCase().includes(this.searchTerm) ||
        post.tags.some((tag) => tag.toLowerCase().includes(this.searchTerm));

      return tagMatch && searchMatch;
    });

    // 显示过滤后的文章
    this.displayPosts(this.filteredPosts);
    this.updateStats();
  }

  updateStats() {
    const displayedCount = this.filteredPosts.length || this.allPosts.length;
    const totalCount = this.allPosts.length;

    this.postsCount.textContent = displayedCount;
    this.totalPosts.textContent = totalCount;
    this.stats.style.display = "block";
  }

  showLoading() {
    if (this.container) {
      this.container.innerHTML = `
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Loading blog posts...</p>
        </div>
      `;
    }
  }

  showError() {
    if (this.container) {
      this.container.innerHTML = `
        <div class="error-state">
          <i class="fas fa-exclamation-triangle"></i>
          <h3>Unable to load blog posts</h3>
          <p>Please check your internet connection and try again.</p>
          <button class="retry-btn" id="retry-loading">Retry</button>
        </div>
      `;

      // 绑定重试按钮
      const retryBtn = document.getElementById("retry-loading");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => this.loadBlogPosts());
      }
    }
  }
}

// 初始化博客加载器
document.addEventListener("DOMContentLoaded", () => {
  // 只有当切换到博客选项卡时才初始化
  const blogTabBtn = document.querySelector('.tab-btn[data-tab="blog"]');
  let blogLoader = null;

  if (blogTabBtn) {
    blogTabBtn.addEventListener("click", () => {
      if (!blogLoader) {
        blogLoader = new BlogLoader();
      }
    });
  }
});
