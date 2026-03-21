# Use the official Ruby image as the base image
FROM ruby:3.4.1-bullseye

# Set environment variables for Rails
ENV RAILS_ENV=production \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_PATH="/bundle" \
    PORT=3000 \
    SECRET_KEY_BASE_DUMMY=1 \
    RAILS_SERVE_STATIC_FILES=true \
    RAILS_LOG_TO_STDOUT=true

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
    build-essential \
    nodejs \
    tzdata \
    libyaml-dev \
    git \
    pkg-config \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Ensure bin/rails is executable and has Unix line endings
COPY bin/rails bin/rails
RUN chmod +x bin/rails && sed -i 's/\r$//' bin/rails

# Copy Gemfile and Gemfile.lock and install dependencies
COPY Gemfile Gemfile.lock ./
RUN bundle install

# Copy the rest of the application code
COPY . .

# Precompile bootsnap cache for faster boot times
RUN bundle exec bootsnap precompile --gemfile app/ lib/

# Precompile assets
RUN bundle exec rails assets:precompile

# Expose the port Rails runs on
EXPOSE 3000

# Command to run the Rails server
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
